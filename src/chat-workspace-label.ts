import * as path from "node:path";
import { resolveUserHomeDir } from "./sync-roots.js";

export function formatDisplayPath(
  folderFsPath: string,
  homeDir: string = resolveUserHomeDir()
): string {
  const normalized = path.resolve(folderFsPath);
  const home = path.resolve(homeDir);
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (normalized === home) {
    return "~";
  }
  if (normalized.startsWith(homeWithSep)) {
    return "~" + path.sep + normalized.slice(homeWithSep.length);
  }
  return normalized;
}

export function humanWorkspaceLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const last = parts[parts.length - 1]!;
  const withoutHash = last.length === 40 || last.length === 8 ? parts.slice(0, -1) : parts;
  return withoutHash.join("-");
}

function resolveFolderForProjectDir(
  projectFolderName: string,
  map: Map<string, string>
): string | undefined {
  const label = humanWorkspaceLabel(projectFolderName).toLowerCase();
  for (const folderFsPath of map.values()) {
    const base = path.basename(folderFsPath).toLowerCase();
    if (base === label) {
      return folderFsPath;
    }
    const folderLabel = humanWorkspaceLabel(path.basename(folderFsPath)).toLowerCase();
    if (folderLabel === label) {
      return folderFsPath;
    }
    const loosePath = folderFsPath.toLowerCase();
    const looseLabel = label.replace(/-/g, path.sep);
    if (
      projectFolderName.toLowerCase().includes(base) ||
      loosePath.includes(looseLabel)
    ) {
      return folderFsPath;
    }
  }
  return undefined;
}

export function workspaceQuickPickLabel(
  chatsKey: string,
  map: Map<string, string>,
  homeDir?: string
): { label: string; description: string } {
  const folderFsPath = map.get(chatsKey);
  if (folderFsPath) {
    return {
      label: formatDisplayPath(folderFsPath, homeDir),
      description: chatsKey,
    };
  }
  return {
    label: humanWorkspaceLabel(chatsKey),
    description: chatsKey,
  };
}

export function projectQuickPickLabel(
  projectFolderName: string,
  map: Map<string, string>,
  homeDir?: string
): string {
  const folderFsPath = resolveFolderForProjectDir(projectFolderName, map);
  if (folderFsPath) {
    return formatDisplayPath(folderFsPath, homeDir);
  }
  return humanWorkspaceLabel(projectFolderName);
}
