import * as vscode from "vscode";
import { nodePlatform } from "./os-runtime.js";
import { enumerateSyncFiles, syncKeyToGistFileName } from "./paths.js";
import { packageFiles } from "./packaging.js";
import { GistClient } from "./gist.js";
import { requireToken } from "./auth.js";
import { withRetry } from "./retry.js";
import { getLogger } from "./diagnostics.js";
import { generateExtensionsJson } from "./extensions.js";
import * as fs from "node:fs/promises";
import { requireE2eUnlocked } from "./e2e/gate.js";
import { wrapGistFilesForUpload } from "./e2e/gist-bundle.js";
import { assertPlaintextGistWriteAllowed } from "./e2e/gist-plaintext-guard.js";

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

  const e2e = await requireE2eUnlocked(context, { gistSync: true });
  if (!e2e.ok) {
    vscode.window.showWarningMessage(e2e.message);
    return;
  }

  const extensionsJson = generateExtensionsJson();
  const { resolveSyncRoots } = await import("./paths.js");
  const roots = resolveSyncRoots(nodePlatform(), context);
  const cursorUserRoot = roots.cursorUser;
  await writeExtensionsFile(cursorUserRoot, extensionsJson);

  const files = await enumerateSyncFiles(context, roots);
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
    title: "Select files to export to a private Gist",
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

  const logicalGistFiles: Record<string, { content: string }> = {};
  logicalGistFiles["manifest.json"] = { content: JSON.stringify(manifest, null, 2) };

  for (const [key, value] of packaged) {
    const gistFileName = syncKeyToGistFileName(key);
    logicalGistFiles[gistFileName] = { content: value.content };
  }

  const usePlaintextGist = e2e.kind === "gist_plaintext";
  const client = new GistClient(token);
  if (usePlaintextGist) {
    const guard = await assertPlaintextGistWriteAllowed(client);
    if (!guard.ok) {
      vscode.window.showWarningMessage(guard.message);
      return;
    }
  }

  const gistFiles = usePlaintextGist
    ? logicalGistFiles
    : wrapGistFilesForUpload(e2e.dek, e2e.userId, e2e.keyVersion, logicalGistFiles);
  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Creating private Gist...",
      cancellable: false,
    },
    async () => {
      const result = await withRetry(() =>
        client.createGist(gistFiles, "Cursor Sync - Export")
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
        `Export successful! Private Gist at ${gistUrl}. Anyone with the link can open it.`,
        "Copy URL"
      );

      if (action === "Copy URL") {
        await vscode.env.clipboard.writeText(gistUrl);
        vscode.window.showInformationMessage("Gist URL copied to clipboard.");
      }
    }
  );
}
