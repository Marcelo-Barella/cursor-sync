import type * as vscode from "vscode";

export function asExtensionContext(
  partial: Record<string, unknown>
): vscode.ExtensionContext {
  return partial as unknown as vscode.ExtensionContext;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value as unknown as unknown as Record<string, unknown>;
}
