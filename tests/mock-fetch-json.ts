export function mockFetchJsonResponse(
  body: unknown,
  options?: { ok?: boolean; status?: number }
): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  const text = JSON.stringify(body);
  return {
    ok: options?.ok ?? true,
    status: options?.status ?? 200,
    text: async () => text,
    json: async () => body,
  };
}
