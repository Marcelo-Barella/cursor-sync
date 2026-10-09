import * as vscode from "vscode";

export function dekSecretKey(userId: string, keyVersion: number): string {
  return `cursorSync.e2e.dek.${userId}.${keyVersion}`;
}

export async function loadStoredDek(
  context: vscode.ExtensionContext,
  userId: string,
  keyVersion: number
): Promise<Buffer | undefined> {
  const raw = await context.secrets.get(dekSecretKey(userId, keyVersion));
  if (!raw) {
    return undefined;
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    return undefined;
  }
  return buf;
}

export async function storeDek(
  context: vscode.ExtensionContext,
  userId: string,
  keyVersion: number,
  dek: Buffer
): Promise<void> {
  await context.secrets.store(dekSecretKey(userId, keyVersion), dek.toString("base64"));
}

export async function clearStoredDekForUser(
  context: vscode.ExtensionContext,
  userId: string,
  keyVersion: number
): Promise<void> {
  await context.secrets.delete(dekSecretKey(userId, keyVersion));
}

export async function clearAllStoredDeks(context: vscode.ExtensionContext): Promise<void> {
  const versions = context.globalState.get<number[]>("cursorSync.e2e.dekVersions") ?? [];
  const userId = context.globalState.get<string>("cursorSync.e2e.lastUserId");
  if (userId) {
    for (const version of versions) {
      await context.secrets.delete(dekSecretKey(userId, version));
    }
  }
  await context.globalState.update("cursorSync.e2e.dekVersions", undefined);
  await context.globalState.update("cursorSync.e2e.lastUserId", undefined);
}

export async function rememberDekVersion(
  context: vscode.ExtensionContext,
  userId: string,
  keyVersion: number
): Promise<void> {
  await context.globalState.update("cursorSync.e2e.lastUserId", userId);
  const existing = context.globalState.get<number[]>("cursorSync.e2e.dekVersions") ?? [];
  if (!existing.includes(keyVersion)) {
    await context.globalState.update("cursorSync.e2e.dekVersions", [...existing, keyVersion]);
  }
}
