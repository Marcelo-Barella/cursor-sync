import * as vscode from "vscode";
import { enumerateSyncFiles, syncKeyToGistFileName } from "./paths.js";
import { packageFiles } from "./packaging.js";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import { generateExtensionsJson } from "./extensions.js";
import * as fs from "node:fs/promises";

async function writeExtensionsFile(
  cursorUserRoot: string,
  content: string
): Promise<string> {
  const filePath = (await import("node:path")).join(
    cursorUserRoot,
    "extensions.json"
  );
  const dir = (await import("node:path")).dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

export async function executeExport(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Export started`);

  const token = await requireToken(context);
  if (!token) {
    logger.appendLine(`[${new Date().toISOString()}] Export failed: AUTH_FAILED`);
    return;
  }

  const extensionsJson = generateExtensionsJson();
  const cursorUserRoot = (await import("./paths.js")).resolveSyncRoots().cursorUser;
  await writeExtensionsFile(cursorUserRoot, extensionsJson);

  const files = await enumerateSyncFiles();
  if (files.length === 0) {
    vscode.window.showInformationMessage("No files found to export.");
    return;
  }

  const items: vscode.QuickPickItem[] = files.map((f) => ({
    label: f.relativeSyncKey,
    description: f.absolutePath,
  }));

  const selectedItems = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: "Select files to export to a public Gist",
  });

  if (!selectedItems || selectedItems.length === 0) {
    logger.appendLine(`[${new Date().toISOString()}] Export cancelled or no files selected`);
    return;
  }

  const selectedFiles = files.filter((f) =>
    selectedItems.some((item) => item.label === f.relativeSyncKey)
  );

  const config = vscode.workspace.getConfiguration("cursorSync");
  const profileName = config.get<string>("syncProfileName") ?? "default";
  const { packaged, manifest } = await packageFiles(selectedFiles, profileName);

  const gistFiles: Record<string, { content: string }> = {};
  gistFiles["manifest.json"] = { content: JSON.stringify(manifest, null, 2) };

  for (const [key, value] of packaged) {
    const gistFileName = syncKeyToGistFileName(key);
    gistFiles[gistFileName] = { content: value.content };
  }

  const client = new GistClient(token);
  
  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Creating public Gist...",
      cancellable: false,
    },
    async () => {
      const result = await withRetry(() =>
        client.createGist(gistFiles, "Cursor Sync - Public Export", true)
      );

      if (!result.ok) {
        vscode.window.showErrorMessage(`Export failed: ${result.error.message}`);
        logger.appendLine(
          `[${new Date().toISOString()}] Export failed: ${result.error.category} - ${result.error.message}`
        );
        return;
      }

      const gistUrl = result.data.html_url;
      logger.appendLine(`[${new Date().toISOString()}] Export succeeded: ${gistUrl}`);

      const action = await vscode.window.showInformationMessage(
        `Export successful! Gist created at ${gistUrl}`,
        "Copy URL"
      );

      if (action === "Copy URL") {
        await vscode.env.clipboard.writeText(gistUrl);
        vscode.window.showInformationMessage("Gist URL copied to clipboard.");
      }
    }
  );
}
