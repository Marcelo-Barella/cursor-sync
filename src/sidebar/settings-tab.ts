import * as vscode from "vscode";
import { escapeHtml } from "./sync-tab.js";
import {
  readAppearanceThemePreference,
  type AppearanceThemePreference,
} from "./appearance-theme.js";

export interface SettingsTabValues {
  appearanceTheme: AppearanceThemePreference;
  activateDefault: boolean;
  activateStrict: boolean;
  bridgeWaitResultSeconds: number;
  autoReloadAfterImport: boolean;
  pythonPath: string;
}

export function readSettingsValues(): SettingsTabValues {
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  return {
    appearanceTheme: readAppearanceThemePreference(),
    activateDefault: cfg.get<boolean>("chatImport.activateDefault", false),
    activateStrict: cfg.get<boolean>("chatImport.activateStrict", false),
    bridgeWaitResultSeconds: cfg.get<number>("chatImport.bridgeWaitResultSeconds", 0),
    autoReloadAfterImport: cfg.get<boolean>("transcripts.autoReloadAfterImport", false),
    pythonPath: cfg.get<string>("chatImport.pythonPath", ""),
  };
}

export async function updateSettingValue(
  key: string,
  value: unknown
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("cursorSync");
  await cfg.update(key, value, vscode.ConfigurationTarget.Global);
}

export function renderSettingsPane(values: SettingsTabValues): string {
  function checkbox(id: string, label: string, checked: boolean): string {
    return `<div class="settings-row">
      <label class="settings-label">
        <input type="checkbox" id="${id}" data-setting-key="${id}" ${checked ? "checked" : ""} />
        <span>${label}</span>
      </label>
    </div>`;
  }

  function themeSegment(value: AppearanceThemePreference, label: string): string {
    const active = values.appearanceTheme === value ? " active" : "";
    return `<button type="button" class="theme-segment${active}" data-theme-preference="${value}" aria-pressed="${values.appearanceTheme === value}">${label}</button>`;
  }

  return `<div id="settings-pane" class="tab-pane" style="display:none">
  <div class="section">
    <div class="section-header">Appearance</div>
    <div class="settings-list">
      <div class="settings-row settings-row-theme">
        <span class="settings-label settings-label-static">Sidebar theme</span>
        <div class="theme-segmented" role="group" aria-label="Sidebar theme">
          ${themeSegment("system", "System")}
          ${themeSegment("dark", "Dark")}
          ${themeSegment("light", "Light")}
        </div>
      </div>
      <p class="settings-hint">System follows your Cursor color theme and updates when you switch themes.</p>
    </div>
  </div>
  <div class="section">
    <div class="section-header">Chat Import</div>
    <div class="settings-list">
      ${checkbox("chatImport.activateDefault", "Activate chat after import", values.activateDefault)}
      ${checkbox("chatImport.activateStrict", "Strict activation (require confirmed activation)", values.activateStrict)}
      <div class="settings-row">
        <label class="settings-label" for="chatImport.bridgeWaitResultSeconds">Bridge wait (seconds)</label>
        <input type="number" id="chatImport.bridgeWaitResultSeconds" data-setting-key="chatImport.bridgeWaitResultSeconds" value="${values.bridgeWaitResultSeconds}" min="0" max="120" class="settings-input" />
      </div>
      ${checkbox("transcripts.autoReloadAfterImport", "Auto-reload after import", values.autoReloadAfterImport)}
      <div class="settings-row">
        <label class="settings-label" for="chatImport.pythonPath">Python path</label>
        <input type="text" id="chatImport.pythonPath" data-setting-key="chatImport.pythonPath" value="${escapeHtml(values.pythonPath)}" class="settings-input settings-input-text" />
      </div>
    </div>
  </div>
</div>`;
}
