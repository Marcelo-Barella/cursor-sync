import type * as vscode from "vscode";

let activeExtensionContext: vscode.ExtensionContext | undefined;

export function setActiveExtensionContext(
  context: vscode.ExtensionContext
): void {
  activeExtensionContext = context;
}

export function getActiveExtensionContext(): vscode.ExtensionContext | undefined {
  return activeExtensionContext;
}
