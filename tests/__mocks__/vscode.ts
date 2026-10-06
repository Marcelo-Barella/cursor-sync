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

let mockWorkspaceFolders: Array<{ uri: { fsPath: string } }> = [];

export function __setWorkspaceFolders(
  folders: Array<{ uri: { fsPath: string } }>
): void {
  mockWorkspaceFolders = folders;
}

export class RelativePattern {
  constructor(
    public base: { fsPath?: string },
    public pattern: string
  ) {}
}

export class Disposable {
  constructor(private callOnDispose?: () => void) {}
  dispose(): void {
    this.callOnDispose?.();
  }
}

export const workspace = {
  get workspaceFolders() {
    return mockWorkspaceFolders.length ? mockWorkspaceFolders : undefined;
  },
  createFileSystemWatcher: (
    _pattern: unknown,
    _ignoreCreate?: boolean,
    _ignoreChange?: boolean,
    _ignoreDelete?: boolean
  ) => ({
    onDidCreate: (_cb: () => void) => ({ dispose: () => {} }),
    onDidChange: (_cb: () => void) => ({ dispose: () => {} }),
    onDidDelete: (_cb: () => void) => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeWorkspaceFolders: (_cb: () => void) => ({ dispose: () => {} }),
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const defaults: Record<string, unknown> = {
        enabledPaths: [
          "settings.json",
          "keybindings.json",
          "snippets/**",
          "extensions.json",
          "vsix/**",
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

export enum ProgressLocation {
  Notification = 15,
}

let mockActiveTabInput: unknown;

export function __setActiveTabInput(input: unknown): void {
  mockActiveTabInput = input;
}

let mockShowErrorMessageResult: string | undefined;
let mockShowWarningMessageResult: string | undefined;
let mockShowInformationMessageResult: string | undefined;
let clipboardWriteTextImpl: (text: string) => Promise<void> = async () => {};
export const __infoMessageCalls: string[] = [];

export function __setShowErrorMessageResult(result: string | undefined): void {
  mockShowErrorMessageResult = result;
}

export function __setShowWarningMessageResult(result: string | undefined): void {
  mockShowWarningMessageResult = result;
}

export function __setShowInformationMessageResult(result: string | undefined): void {
  mockShowInformationMessageResult = result;
}

export function __setClipboardWriteTextImpl(
  impl: (text: string) => Promise<void>
): void {
  clipboardWriteTextImpl = impl;
}

export function __resetMessageMocks(): void {
  mockShowErrorMessageResult = undefined;
  mockShowWarningMessageResult = undefined;
  mockShowInformationMessageResult = undefined;
  clipboardWriteTextImpl = async () => {};
  __infoMessageCalls.length = 0;
}

export const env = {
  clipboard: {
    writeText: async (text: string) => clipboardWriteTextImpl(text),
  },
};

export const window = {
  activeColorTheme: { kind: ColorThemeKind.Dark },
  createOutputChannel: (_name: string) => ({
    appendLine: (_msg: string) => {},
    show: () => {},
    dispose: () => {},
  }),
  showInformationMessage: async (msg: string, ..._items: string[]) => {
    __infoMessageCalls.push(msg);
    return mockShowInformationMessageResult;
  },
  showWarningMessage: async (_msg: string, ..._items: string[]) =>
    mockShowWarningMessageResult,
  showErrorMessage: async (_msg: string, ..._items: string[]) =>
    mockShowErrorMessageResult,
  showInputBox: async () => undefined,
  showQuickPick: async <T>(items: T[]) => items[0],
  showSaveDialog: async () => undefined,
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report: (_value: unknown) => void }) => PromiseLike<T> | T
  ) => task({ report: () => {} }),
  tabGroups: {
    activeTabGroup: {
      get activeTab() {
        return mockActiveTabInput === undefined
          ? undefined
          : { input: mockActiveTabInput };
      },
    },
  },
};

let registeredCommands = new Set<string>();
let executeCommandImpl: (
  command: string,
  ...args: unknown[]
) => Promise<unknown> = async () => undefined;

export function __resetVscodeCommandsMock(): void {
  registeredCommands = new Set();
  executeCommandImpl = async () => undefined;
  mockWorkspaceFolders = [];
  __resetMessageMocks();
}

export function __setRegisteredCommands(commandIds: string[]): void {
  registeredCommands = new Set(commandIds);
}

export function __setExecuteCommandImpl(
  impl: (command: string, ...args: unknown[]) => Promise<unknown>
): void {
  executeCommandImpl = impl;
}

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) =>
    executeCommandImpl(command, ...args),
  getCommands: async (_filter?: boolean) => Array.from(registeredCommands),
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

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4,
}

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
  parse: (value: string) => ({ fsPath: value, scheme: "file", path: value }),
  from: (parts: { scheme: string; path: string }) => ({
    fsPath: parts.path,
    scheme: parts.scheme,
    path: parts.path,
  }),
  joinPath: (base: { fsPath: string }, ...segments: string[]) => {
    const fsPath = [base.fsPath, ...segments].join("/");
    return { fsPath, scheme: "file", path: fsPath };
  },
};

