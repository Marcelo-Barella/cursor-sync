import * as vscode from "vscode";

interface ExtensionEntry {
  id: string;
  version: string;
}

export function generateExtensionsJson(): string {
  const extensions = vscode.extensions.all;
  const entries: ExtensionEntry[] = [];

  for (const ext of extensions) {
    if (ext.id.startsWith("vscode.")) {
      continue;
    }

    const kind = ext.extensionKind;
    if (kind === vscode.ExtensionKind.UI) {
      // ExtensionKind.UI = 1, not builtin
    }

    entries.push({
      id: ext.id,
      version: ext.packageJSON?.version ?? "0.0.0",
    });
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(entries, null, 2);
}

export function findMissingExtensions(
  remoteEntries: ExtensionEntry[]
): ExtensionEntry[] {
  const installedIds = new Set(
    vscode.extensions.all
      .filter((ext) => !ext.id.startsWith("vscode."))
      .map((ext) => ext.id.toLowerCase())
  );

  return remoteEntries.filter(
    (entry) => !installedIds.has(entry.id.toLowerCase())
  );
}
