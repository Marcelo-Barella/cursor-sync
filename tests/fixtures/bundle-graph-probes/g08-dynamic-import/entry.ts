export async function loadOutside(): Promise<unknown> {
  return import("../../qa23-outside/home.js");
}
