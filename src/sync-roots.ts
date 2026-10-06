import * as path from "node:path";
import type * as vscode from "vscode";
import { getActiveExtensionContext } from "./extension-host-context.js";
import { resolveSyncRoots, type SyncRoots } from "./paths.js";

export function resolveExtensionSyncRoots(
  context?: vscode.ExtensionContext
): SyncRoots {
  const ctx = context ?? getActiveExtensionContext();
  return resolveSyncRoots(process.platform, ctx);
}

export function resolveUserHomeDir(context?: vscode.ExtensionContext): string {
  return path.dirname(resolveExtensionSyncRoots(context).dotCursor);
}
