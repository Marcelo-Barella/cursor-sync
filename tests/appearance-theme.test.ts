import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import * as vscode from "vscode";
import {
  colorThemeKindToResolved,
  parseAppearanceThemePreference,
  resolveEffectiveSidebarTheme,
} from "../src/sidebar/appearance-theme.js";

describe("parseAppearanceThemePreference", () => {
  it("accepts system, dark, and light", () => {
    expect(parseAppearanceThemePreference("system")).toBe("system");
    expect(parseAppearanceThemePreference("dark")).toBe("dark");
    expect(parseAppearanceThemePreference("light")).toBe("light");
  });

  it("falls back to system for unknown values", () => {
    expect(parseAppearanceThemePreference("")).toBe("system");
    expect(parseAppearanceThemePreference("auto")).toBe("system");
    expect(parseAppearanceThemePreference(undefined)).toBe("system");
  });
});

describe("resolveEffectiveSidebarTheme", () => {
  it("forces dark and light regardless of IDE theme", () => {
    expect(
      resolveEffectiveSidebarTheme("dark", vscode.ColorThemeKind.Light)
    ).toBe("dark");
    expect(
      resolveEffectiveSidebarTheme("light", vscode.ColorThemeKind.Dark)
    ).toBe("light");
  });

  it("maps system from ColorThemeKind", () => {
    expect(
      resolveEffectiveSidebarTheme("system", vscode.ColorThemeKind.Dark)
    ).toBe("dark");
    expect(
      resolveEffectiveSidebarTheme("system", vscode.ColorThemeKind.Light)
    ).toBe("light");
    expect(
      resolveEffectiveSidebarTheme("system", vscode.ColorThemeKind.HighContrastLight)
    ).toBe("light");
    expect(
      resolveEffectiveSidebarTheme("system", vscode.ColorThemeKind.HighContrast)
    ).toBe("dark");
  });
});

describe("colorThemeKindToResolved", () => {
  it("treats high-contrast dark as dark", () => {
    expect(colorThemeKindToResolved(vscode.ColorThemeKind.HighContrast)).toBe("dark");
  });
});
