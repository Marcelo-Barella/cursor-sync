import * as vscode from "vscode";
import {
  APPEARANCE_THEME_SETTING_KEY,
  readAppearanceThemePreference,
  resolveEffectiveSidebarTheme,
  type AppearanceThemePreference,
  type ResolvedSidebarTheme,
} from "./appearance-theme.js";

export interface SidebarThemeMessage {
  type: "theme:apply";
  preference: AppearanceThemePreference;
  effective: ResolvedSidebarTheme;
}

export type ThemeWebviewTarget = {
  postMessage(message: SidebarThemeMessage): Thenable<boolean>;
};

export class SidebarThemeController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly webviews = new Set<ThemeWebviewTarget>();

  constructor() {
    this.disposables.push(
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (readAppearanceThemePreference() === "system") {
          this.broadcast();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`cursorSync.${APPEARANCE_THEME_SETTING_KEY}`)) {
          this.broadcast();
        }
      })
    );
  }

  registerWebview(webview: ThemeWebviewTarget): void {
    this.webviews.add(webview);
    void this.pushTo(webview);
  }

  unregisterWebview(webview: ThemeWebviewTarget): void {
    this.webviews.delete(webview);
  }

  getResolvedTheme(): ResolvedSidebarTheme {
    return resolveEffectiveSidebarTheme(
      readAppearanceThemePreference(),
      vscode.window.activeColorTheme.kind
    );
  }

  buildThemeMessage(): SidebarThemeMessage {
    return {
      type: "theme:apply",
      preference: readAppearanceThemePreference(),
      effective: this.getResolvedTheme(),
    };
  }

  private broadcast(): void {
    const message = this.buildThemeMessage();
    for (const webview of this.webviews) {
      void webview.postMessage(message);
    }
  }

  private async pushTo(webview: ThemeWebviewTarget): Promise<void> {
    await webview.postMessage(this.buildThemeMessage());
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.webviews.clear();
  }
}

let sharedController: SidebarThemeController | undefined;

export function getSidebarThemeController(): SidebarThemeController {
  if (!sharedController) {
    sharedController = new SidebarThemeController();
  }
  return sharedController;
}

export function disposeSidebarThemeController(): void {
  sharedController?.dispose();
  sharedController = undefined;
}
