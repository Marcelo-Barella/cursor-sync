/** Thrown when an allowlisted command cannot be resolved on PATH (maps to spawn ENOENT). */
export class SubprocessCommandNotFoundError extends Error {
  readonly code = "ENOENT";
  readonly command: string;

  constructor(command: string) {
    super(`Subprocess command not found on PATH: ${command}`);
    this.name = "SubprocessCommandNotFoundError";
    this.command = command;
  }
}

export function isSubprocessCommandNotFoundError(error: unknown): boolean {
  return error instanceof SubprocessCommandNotFoundError;
}
