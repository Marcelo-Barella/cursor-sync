import * as vscode from "vscode";

export type AppearanceThemePreference = "system" | "dark" | "light";
export type ResolvedSidebarTheme = "dark" | "light";

export const APPEARANCE_THEME_SETTING_KEY = "appearance.theme";

export function parseAppearanceThemePreference(
  value: string | undefined
): AppearanceThemePreference {
  if (value === "dark" || value === "light" || value === "system") {
    return value;
  }
  return "system";
}

export function readAppearanceThemePreference(): AppearanceThemePreference {
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  const raw = cfg.get<string>(APPEARANCE_THEME_SETTING_KEY, "system");
  return parseAppearanceThemePreference(raw);
}

export function colorThemeKindToResolved(kind: vscode.ColorThemeKind): ResolvedSidebarTheme {
  if (
    kind === vscode.ColorThemeKind.Light ||
    kind === vscode.ColorThemeKind.HighContrastLight
  ) {
    return "light";
  }
  return "dark";
}

export function resolveEffectiveSidebarTheme(
  preference: AppearanceThemePreference,
  activeColorThemeKind: vscode.ColorThemeKind
): ResolvedSidebarTheme {
  if (preference === "dark") {
    return "dark";
  }
  if (preference === "light") {
    return "light";
  }
  return colorThemeKindToResolved(activeColorThemeKind);
}
