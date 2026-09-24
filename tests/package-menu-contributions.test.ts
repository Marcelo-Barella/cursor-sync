import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackageJson(): Record<string, any> {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}

function configurationProperties(pkg: Record<string, unknown>): Record<string, unknown> {
  const configuration = pkg.contributes?.configuration;
  if (!configuration) {
    return {};
  }
  if (Array.isArray(configuration)) {
    return configuration.reduce<Record<string, unknown>>((merged, section) => {
      return { ...merged, ...(section.properties ?? {}) };
    }, {});
  }
  return (configuration as { properties?: Record<string, unknown> }).properties ?? {};
}

describe("package menu contributions", () => {
  it("declares the current-chat bundle export command", () => {
    const pkg = readPackageJson();
    const command = pkg.contributes.commands.find(
      (entry: { command: string }) => entry.command === "cursorSync.exportCurrentChatBundle"
    );
    expect(command).toEqual({
      command: "cursorSync.exportCurrentChatBundle",
      title: "Cursor Sync: Export into Bundle",
      icon: "$(archive)",
    });
  });

  it("contributes current-chat export to editor title and tab context menus", () => {
    const pkg = readPackageJson();
    expect(pkg.contributes.menus["editor/title"]).toContainEqual({
      command: "cursorSync.exportCurrentChatBundle",
      when: "resourceScheme == 'cursor.composer'",
      group: "navigation",
    });
    expect(pkg.contributes.menus["editor/title/context"]).toContainEqual({
      command: "cursorSync.exportCurrentChatBundle",
      when: "resourceScheme == 'cursor.composer'",
      group: "navigation",
    });
  });

  it("hides the context command from the Command Palette", () => {
    const pkg = readPackageJson();
    expect(pkg.contributes.menus.commandPalette).toContainEqual({
      command: "cursorSync.exportCurrentChatBundle",
      when: "false",
    });
  });

  it("declares the current-chat gist bundle export command", () => {
    const pkg = readPackageJson();
    const command = pkg.contributes.commands.find(
      (entry: { command: string }) => entry.command === "cursorSync.exportCurrentChatBundleToGist"
    );
    expect(command).toEqual({
      command: "cursorSync.exportCurrentChatBundleToGist",
      title: "Cursor Sync: Export into Bundle (GIST)",
      icon: "$(cloud-upload)",
    });
  });

  it("contributes current-chat gist export to editor title and tab context menus", () => {
    const pkg = readPackageJson();
    expect(pkg.contributes.menus["editor/title"]).toContainEqual({
      command: "cursorSync.exportCurrentChatBundleToGist",
      when: "resourceScheme == 'cursor.composer'",
      group: "navigation",
    });
    expect(pkg.contributes.menus["editor/title/context"]).toContainEqual({
      command: "cursorSync.exportCurrentChatBundleToGist",
      when: "resourceScheme == 'cursor.composer'",
      group: "navigation",
    });
  });

  it("hides the gist context command from the Command Palette", () => {
    const pkg = readPackageJson();
    expect(pkg.contributes.menus.commandPalette).toContainEqual({
      command: "cursorSync.exportCurrentChatBundleToGist",
      when: "false",
    });
  });

  it("declares chat gist encryption setting default true", () => {
    const pkg = readPackageJson();
    expect(configurationProperties(pkg)["cursorSync.chatGist.encrypt"]).toEqual({
      type: "boolean",
      default: true,
      description: expect.stringMatching(/encrypt/i),
    });
  });

  it("declares set chat encryption password command", () => {
    const pkg = readPackageJson();
    const command = pkg.contributes.commands.find(
      (entry: { command: string }) => entry.command === "cursorSync.setChatEncryptionPassword"
    );
    expect(command?.title).toMatch(/Set Chat Encryption Password/i);
  });
});
