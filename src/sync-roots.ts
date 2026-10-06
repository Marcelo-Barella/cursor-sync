import type * as vscode from "vscode";
import { getActiveExtensionContext } from "./extension-host-context.js";
import { resolveSyncRoots, type SyncRoots } from "./paths.js";

export function resolveExtensionSyncRoots(
  context?: vscode.ExtensionContext
): SyncRoots {
  const ctx = context ?? getActiveExtensionContext();
  return resolveSyncRoots(process.platform, ctx);
}
