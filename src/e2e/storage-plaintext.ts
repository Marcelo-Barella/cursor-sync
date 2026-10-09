import * as vscode from "vscode";
import { getAppApiUrl } from "../config/urls.js";
import { getAppSession } from "../app-auth.js";

export type PlaintextObjectDeleteStatus = "deleted" | "not_found" | "failed";

export interface PlaintextObjectDeleteResultRow {
  key: string;
  status: PlaintextObjectDeleteStatus;
}

export interface PlaintextDeleteOutcome {
  settled: string[];
  failed: string[];
  partial: boolean;
  results: PlaintextObjectDeleteResultRow[];
}

function parseDeleteResultsBody(data: unknown): PlaintextObjectDeleteResultRow[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const record = data as Record<string, unknown>;
  const results = record.results;
  if (!Array.isArray(results)) {
    const legacyDeleted = record.deleted;
    if (Array.isArray(legacyDeleted)) {
      return legacyDeleted
        .filter((k): k is string => typeof k === "string")
        .map((key) => ({ key, status: "deleted" as const }));
    }
    return [];
  }
  const rows: PlaintextObjectDeleteResultRow[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key : undefined;
    const status = row.status;
    if (!key) {
      continue;
    }
    if (status === "deleted" || status === "not_found" || status === "failed") {
      rows.push({ key, status });
    }
  }
  return rows;
}

function outcomeFromRows(rows: PlaintextObjectDeleteResultRow[], partial: boolean): PlaintextDeleteOutcome {
  const settled: string[] = [];
  const failed: string[] = [];
  for (const row of rows) {
    if (row.status === "deleted" || row.status === "not_found") {
      settled.push(row.key);
    } else {
      failed.push(row.key);
    }
  }
  return {
    settled,
    failed,
    partial: partial || failed.length > 0,
    results: rows,
  };
}

export async function listPlaintextObjectKeys(
  context: vscode.ExtensionContext
): Promise<string[]> {
  const session = await getAppSession(context);
  if (!session) {
    return [];
  }
  const base = getAppApiUrl().replace(/\/$/, "");
  const response = await fetch(`${base}/v1/storage/plaintext-objects`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${session}`,
      Accept: "application/json",
    },
  });
  if (response.status === 401) {
    return [];
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to list plaintext objects (${response.status})${text ? `: ${text}` : ""}`
    );
  }
  const data = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(data.keys)) {
    return [];
  }
  return data.keys.filter((k): k is string => typeof k === "string").sort();
}

export async function deletePlaintextR2Objects(
  context: vscode.ExtensionContext,
  keys: string[]
): Promise<PlaintextDeleteOutcome> {
  if (keys.length === 0) {
    return { settled: [], failed: [], partial: false, results: [] };
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

  const text = await response.text().catch(() => "");
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = {};
    }
  }

  const rows = parseDeleteResultsBody(data);
  const partial = response.status === 502 || !response.ok;
  if (!response.ok && response.status !== 502 && rows.length === 0) {
    throw new Error(
      `Failed to delete plaintext objects (${response.status})${text ? `: ${text}` : ""}`
    );
  }
  return outcomeFromRows(rows, partial);
}
