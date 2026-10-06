import type * as vscode from "vscode";

export const APP_CONFIG_REMOTE_DIRTY_KEY = "cursorSync.appConfigs.remoteDirty";

export interface RemoteDirtyState {
  at: string;
  reason: string;
  mismatchKeys?: string[];
}

export async function markAppConfigRemoteDirty(
  context: vscode.ExtensionContext,
  reason: string,
  mismatchKeys?: string[]
): Promise<void> {
  await context.globalState.update(APP_CONFIG_REMOTE_DIRTY_KEY, {
    at: new Date().toISOString(),
    reason,
    ...(mismatchKeys && mismatchKeys.length > 0 ? { mismatchKeys } : {}),
  } satisfies RemoteDirtyState);
}

export function readAppConfigRemoteDirty(
  context: vscode.ExtensionContext
): RemoteDirtyState | undefined {
  return context.globalState.get<RemoteDirtyState>(APP_CONFIG_REMOTE_DIRTY_KEY);
}

export async function clearAppConfigRemoteDirty(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.globalState.update(APP_CONFIG_REMOTE_DIRTY_KEY, undefined);
}
