export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const defaults: Record<string, unknown> = {
        enabledPaths: [
          "settings.json",
          "keybindings.json",
          "snippets/**",
          "extensions.json",
          "skills/**/SKILL.md",
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
