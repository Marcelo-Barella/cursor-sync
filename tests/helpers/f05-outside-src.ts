export function readHome(): string {
  return process.env.HOME ?? "";
}
