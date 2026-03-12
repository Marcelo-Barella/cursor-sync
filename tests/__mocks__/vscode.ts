export class TreeItem {
  label: string;
  description?: string;
  collapsibleState?: number;
  command?: { command: string; title: string };
  iconPath?: unknown;
  tooltip?: unknown;
  contextValue?: string;
  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  constructor(public id: string, public color?: unknown) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  value = "";
  appendMarkdown(val: string): this {
    this.value += val;
    return this;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event: (listener: (e: T) => void) => { dispose: () => void } = (listener) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }
  dispose(): void {}
}

export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const defaults: Record<string, unknown> = {
        enabledPaths: [
          "settings.json",
          "keybindings.json",
          "snippets/**",
          "extensions.json",
          "skills/**",
          "skills-cursor/**/SKILL.md",
          "commands/**/*.md",
          "rules/*.mdc",
        ],
        excludeGlobs: [],
        maxFileSizeKB: 512,
        syncProfileName: "default",
        safeMode: true,
        "schedule.enabled": false,
        "schedule.intervalMin": 30,
      };
      return (defaults[key] as T) ?? defaultValue;
    },
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_msg: string) => {},
    show: () => {},
    dispose: () => {},
  }),
  showInformationMessage: async (_msg: string, ..._items: string[]) => undefined,
  showWarningMessage: async (_msg: string, ..._items: string[]) => undefined,
  showErrorMessage: async (_msg: string, ..._items: string[]) => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async <T>(items: T[]) => items[0],
};

export const commands = {
  executeCommand: async (_command: string, ..._args: unknown[]) => {},
  registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown) => ({
    dispose: () => {},
  }),
};

export const extensions = {
  all: [],
};

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: "file" }),
  parse: (value: string) => ({ fsPath: value, scheme: "file" }),
};
