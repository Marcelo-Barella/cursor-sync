import * as vscode from "vscode";
import { getAppApiUrl } from "../config/urls.js";
import { getAppSession } from "../app-auth.js";

export async function deletePlaintextR2Objects(
  context: vscode.ExtensionContext,
  keys: string[]
): Promise<string[]> {
  if (keys.length === 0) {
    return [];
  }
  const session = await getAppSession(context);
  if (!session) {
    throw new Error("App session required");
  }
  const base = getAppApiUrl().replace(/\/$/, "");
  const response = await fetch(`${base}/v1/storage/plaintext-objects/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ keys }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to delete plaintext objects (${response.status})${text ? `: ${text}` : ""}`
    );
  }
  const data = (await response.json()) as { deleted?: string[] };
  return Array.isArray(data.deleted) ? data.deleted : [];
}
