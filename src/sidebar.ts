import * as vscode from "vscode";
import { loadSyncState } from "./diagnostics.js";

let sidebarProviderInstance: SidebarProvider | undefined;

export function initializeSidebar(context: vscode.ExtensionContext): SidebarProvider {
  sidebarProviderInstance = new SidebarProvider(context);
  return sidebarProviderInstance;
}

export function refreshSidebar(): void {
  sidebarProviderInstance?.refresh();
}

export class SyncTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly description: string | undefined,
    public readonly commandId: string | undefined,
    public readonly iconPath: vscode.ThemeIcon | string | undefined,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    public readonly tooltip?: string | vscode.MarkdownString,
    public readonly contextValue?: string
  ) {
    super(label, collapsibleState);
    this.description = description;

    if (commandId) {
      this.command = {
        command: commandId,
        title: label,
      };
    }

    if (iconPath) {
      this.iconPath = iconPath;
    }

    if (tooltip) {
      this.tooltip = tooltip;
    }

    if (contextValue) {
      this.contextValue = contextValue;
    }
  }
}

export class SidebarProvider implements vscode.TreeDataProvider<SyncTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<SyncTreeItem | undefined | null | void> = new vscode.EventEmitter<SyncTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<SyncTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  constructor(private context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SyncTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SyncTreeItem): Promise<SyncTreeItem[]> {
    if (!element) {
      // Root categories
      return [
        new SyncTreeItem(
          "Status",
          undefined,
          undefined,
          new vscode.ThemeIcon("pulse", new vscode.ThemeColor("charts.blue")),
          vscode.TreeItemCollapsibleState.Expanded,
          "View current sync status and history"
        ),
        new SyncTreeItem(
          "Actions",
          undefined,
          undefined,
          new vscode.ThemeIcon("zap", new vscode.ThemeColor("charts.yellow")),
          vscode.TreeItemCollapsibleState.Expanded,
          "Perform manual sync actions"
        ),
        new SyncTreeItem(
          "Configuration",
          undefined,
          undefined,
          new vscode.ThemeIcon("settings-gear", new vscode.ThemeColor("charts.purple")),
          vscode.TreeItemCollapsibleState.Expanded,
          "Manage extension settings and authentication"
        )
      ];
    }

    const syncState = await loadSyncState(this.context);
    const lastSyncStr = syncState ? new Date(syncState.lastSyncTimestamp).toLocaleString() : "Never";

    if (element.label === "Status") {
      const statusTooltip = new vscode.MarkdownString();
      statusTooltip.appendMarkdown(`**Last Synced:** ${lastSyncStr}\n\n`);
      if (syncState) {
        statusTooltip.appendMarkdown(`**Direction:** ${syncState.lastSyncDirection}\n\n`);
      }
      statusTooltip.appendMarkdown(`Click to view detailed sync status.`);

      const statusIcon = syncState 
        ? new vscode.ThemeIcon("pass", new vscode.ThemeColor("testing.iconPassed"))
        : new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));

      return [
        new SyncTreeItem(
          syncState ? "Synced" : "Not Synced",
          syncState ? lastSyncStr : "Never",
          "cursorSync.showStatus",
          statusIcon,
          vscode.TreeItemCollapsibleState.None,
          statusTooltip,
          "statusItem"
        )
      ];
    }

    if (element.label === "Actions") {
      return [
        new SyncTreeItem(
          "Push Now",
          "Upload local settings",
          "cursorSync.push",
          new vscode.ThemeIcon("cloud-upload", new vscode.ThemeColor("charts.green")),
          vscode.TreeItemCollapsibleState.None,
          "Manually push your local Cursor settings to the remote GitHub Gist."
        ),
        new SyncTreeItem(
          "Pull Now",
          "Download remote settings",
          "cursorSync.pull",
          new vscode.ThemeIcon("cloud-download", new vscode.ThemeColor("charts.orange")),
          vscode.TreeItemCollapsibleState.None,
          "Manually pull remote settings from your GitHub Gist and apply them locally."
        )
      ];
    }

    if (element.label === "Configuration") {
      return [
        new SyncTreeItem(
          "Configure GitHub",
          "Set up Gist token",
          "cursorSync.configureGithub",
          new vscode.ThemeIcon("github-alt", new vscode.ThemeColor("textLink.foreground")),
          vscode.TreeItemCollapsibleState.None,
          "Configure your GitHub Personal Access Token and Gist ID for syncing."
        )
      ];
    }

    return [];
  }
}
