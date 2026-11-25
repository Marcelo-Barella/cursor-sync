import { execFileAsync, nodePlatform } from "./os-runtime.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveExtensionSyncRoots } from "./sync-roots.js";

export async function executeInstallSkillTransportChat(
  context: vscode.ExtensionContext
): Promise<void> {
  if (nodePlatform() !== "linux") {
    await vscode.window.showErrorMessage(
      "Cursor Sync: The transport-chat skill is currently supported on Linux only."
    );
    return;
  }

  const bundledPath = vscode.Uri.joinPath(
    context.extensionUri,
    "resources",
    "transport-chat"
  ).fsPath;
  const target = path.join(
    resolveExtensionSyncRoots(context).dotCursor,
    "skills",
    "transport-chat"
  );

  try {
    let bundledVersion: string;
    try {
      bundledVersion = (
        await fs.readFile(path.join(bundledPath, "VERSION"), "utf8")
      ).trim();
    } catch {
      await vscode.window.showErrorMessage(
        "Bundled transport-chat skill is missing a VERSION file; reinstall the extension."
      );
      return;
    }

    let installedVersion: string | null = null;
    try {
      installedVersion = (
        await fs.readFile(path.join(target, "VERSION"), "utf8")
      ).trim();
    } catch {
      installedVersion = null;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(bundledPath, target, { recursive: true, force: true });
    await chmodScripts(path.join(target, "scripts"));

    if (installedVersion === null) {
      await vscode.window.showInformationMessage(
        `Cursor Sync: Installed transport-chat skill v${bundledVersion} at ${target}.`
      );
    } else if (installedVersion === bundledVersion) {
      await vscode.window.showInformationMessage(
        `Cursor Sync: Reinstalled transport-chat skill v${bundledVersion} (no version change).`
      );
    } else {
      await vscode.window.showInformationMessage(
        `Cursor Sync: Updated transport-chat skill ${installedVersion} -> ${bundledVersion}.`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await vscode.window.showErrorMessage(message);
  }
}

async function chmodScripts(scriptsDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(scriptsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      const name = ent.name.toString();
      if (!name.endsWith(".sh") && !name.endsWith(".py")) continue;
      try {
        await execFileAsync("chmod", ["+x", path.join(scriptsDir, name)], {});
      } catch {
        continue;
      }
    }
  } catch {
    return;
  }
}
