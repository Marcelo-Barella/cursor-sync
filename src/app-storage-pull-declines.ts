import type * as vscode from "vscode";

const STORAGE_KEY = "appStorage.declinedPullOverwriteKeys";

export async function getDeclinedPullOverwriteKeys(
  context: vscode.ExtensionContext
): Promise<Set<string>> {
  const raw = context.globalState.get<string[]>(STORAGE_KEY);
  return new Set(raw ?? []);
}

export async function addDeclinedPullOverwriteKeys(
  context: vscode.ExtensionContext,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const set = await getDeclinedPullOverwriteKeys(context);
  for (const key of keys) {
    set.add(key);
  }
  await context.globalState.update(STORAGE_KEY, [...set]);
}

export async function clearDeclinedPullOverwriteKeys(
  context: vscode.ExtensionContext,
  keys: string[]
): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const set = await getDeclinedPullOverwriteKeys(context);
  for (const key of keys) {
    set.delete(key);
  }
  await context.globalState.update(STORAGE_KEY, [...set]);
}
