import * as crypto from "node:crypto";
import { deviceIdentitySalt } from "./os-runtime.js";

export const TRANSCRIPT_MANIFEST_FILE_NAME = "transcript-manifest.json";

export interface TranscriptProjectInfo {
  folderName: string;
  fileCount: number;
}

export interface TranscriptManifestFileEntry {
  projectKey: string;
  checksum: string;
  sizeBytes: number;
}

export interface TranscriptManifestV1 {
  schemaVersion: 1;
  type: "agent-transcripts";
  createdAt: string;
  sourceMachineId: string;
  sourceOS: string;
  sourceProjects: Record<string, TranscriptProjectInfo>;
  files: Record<string, TranscriptManifestFileEntry>;
}

export type TranscriptBundleArtifactKind = "transcript" | "store" | "sidebar";
export type TranscriptBundleArtifactEncoding = "base64";

export interface TranscriptBundleSourceProjectInfo {
  folderName: string;
  fileCount: number;
  conversationCount: number;
  artifactCount: number;
}

export interface TranscriptBundleArtifactEntry {
  projectKey: string;
  conversationId: string;
  kind: TranscriptBundleArtifactKind;
  checksum: string;
  sizeBytes: number;
  contentType: string;
  encoding?: TranscriptBundleArtifactEncoding;
  sourceRelativePath?: string;
  sourceWorkspaceKey?: string;
}

export interface TranscriptBundleConversationEntry {
  projectKey: string;
  conversationId: string;
  title: string;
  subtitle: string;
  previewText: string;
  lastUpdatedAt: string;
  transcriptArtifacts: string[];
  storeArtifact?: string;
  storeSourceWorkspaceKey?: string;
  sidebarArtifact: string;
  warnings: string[];
}

export interface TranscriptManifestV2 {
  schemaVersion: 2;
  type: "agent-transcripts";
  createdAt: string;
  sourceMachineId: string;
  sourceOS: string;
  sourceProjects: Record<string, TranscriptBundleSourceProjectInfo>;
  artifacts: Record<string, TranscriptBundleArtifactEntry>;
  conversations: Record<string, TranscriptBundleConversationEntry>;
  warnings: string[];
}

export type TranscriptBundleManifest = TranscriptManifestV1 | TranscriptManifestV2;

export interface EncodedTranscriptArtifact {
  content: string;
  encoding?: TranscriptBundleArtifactEncoding;
}

export interface TranscriptSidebarSummary {
  title: string;
  subtitle: string;
  previewText: string;
  messageCount: number;
  participants: string[];
  lastUpdatedAt?: string;
}

export function transcriptSyncKey(projectKey: string, relativePath: string): string {
  return `transcripts/${projectKey}/${relativePath}`;
}

export function bundleArtifactSyncKey(
  projectKey: string,
  conversationId: string,
  kind: TranscriptBundleArtifactKind,
  relativePath: string
): string {
  return `artifacts/${projectKey}/${conversationId}/${kind}/${relativePath}`;
}

export function syncKeyToGistFileName(syncKey: string): string {
  return syncKey.replace(/\//g, "--");
}

export function gistFileNameToSyncKey(gistFileName: string): string {
  return gistFileName.replace(/--/g, "/");
}

export function computeTranscriptMachineId(): string {
  const raw = deviceIdentitySalt();
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export function computeArtifactChecksum(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function encodeTranscriptArtifact(
  content: Buffer,
  forceBase64: boolean = false
): EncodedTranscriptArtifact {
  if (forceBase64 || !isValidUtf8(content)) {
    return {
      content: content.toString("base64"),
      encoding: "base64",
    };
  }

  return {
    content: content.toString("utf-8"),
  };
}

export function decodeTranscriptArtifact(
  content: string,
  encoding?: TranscriptBundleArtifactEncoding
): Buffer {
  return encoding === "base64"
    ? Buffer.from(content, "base64")
    : Buffer.from(content, "utf-8");
}

export function getConversationIdFromRelativePath(relativePath: string): string {
  const [conversationId] = relativePath.split("/");
  return conversationId || relativePath;
}

export function getConversationScopedRelativePath(relativePath: string): string {
  const segments = relativePath.split("/");
  return segments.length <= 1 ? segments[0] ?? relativePath : segments.slice(1).join("/");
}

export function parseTranscriptBundleManifest(raw: string): TranscriptBundleManifest {
  const parsed = JSON.parse(raw) as Partial<TranscriptBundleManifest>;

  if (!parsed || parsed.type !== "agent-transcripts") {
    throw new Error("Manifest type must be agent-transcripts.");
  }

  if (parsed.schemaVersion === 1) {
    if (!isRecord(parsed.sourceProjects) || !isRecord(parsed.files)) {
      throw new Error("Manifest schemaVersion 1 is missing sourceProjects or files.");
    }

    return parsed as TranscriptManifestV1;
  }

  if (parsed.schemaVersion === 2) {
    if (
      !isRecord(parsed.sourceProjects) ||
      !isRecord(parsed.artifacts) ||
      !isRecord(parsed.conversations) ||
      !Array.isArray(parsed.warnings)
    ) {
      throw new Error(
        "Manifest schemaVersion 2 is missing sourceProjects, artifacts, conversations, or warnings."
      );
    }

    return parsed as TranscriptManifestV2;
  }

  throw new Error(`Unsupported transcript schemaVersion: ${String(parsed.schemaVersion)}`);
}

export function isTranscriptManifestV2(
  manifest: TranscriptBundleManifest
): manifest is TranscriptManifestV2 {
  return manifest.schemaVersion === 2;
}

export function summarizeTranscriptForSidebar(
  transcriptContent: string,
  conversationId: string
): TranscriptSidebarSummary {
  const participants = new Set<string>();
  const snippets: string[] = [];
  let messageCount = 0;
  let lastUpdatedAt: string | undefined;

  for (const rawLine of transcriptContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let parsedLine: Record<string, unknown>;
    try {
      parsedLine = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    messageCount += 1;

    if (typeof parsedLine.role === "string" && parsedLine.role.trim().length > 0) {
      participants.add(parsedLine.role.trim());
    }

    const timestamp = getTimestampCandidate(parsedLine);
    if (timestamp) {
      lastUpdatedAt = timestamp;
    }

    for (const snippet of collectTranscriptSnippets(parsedLine)) {
      const normalized = normalizePreviewLine(snippet);
      if (normalized) {
        snippets.push(normalized);
      }
    }
  }

  const title = truncateText(snippets[0] ?? conversationId, 96);
  const previewText = truncateText(
    snippets[snippets.length - 1] ?? snippets[0] ?? conversationId,
    140
  );
  const participantList = [...participants];
  const subtitleParts = [`${messageCount} message${messageCount === 1 ? "" : "s"}`];
  if (participantList.length > 0) {
    subtitleParts.push(participantList.join(", "));
  }

  return {
    title,
    subtitle: subtitleParts.join(" · "),
    previewText,
    messageCount,
    participants: participantList,
    lastUpdatedAt,
  };
}

export const BOILERPLATE_PREFIXES = [
  "The user has manually attached the following skills",
  "<manually_attached_skills>",
  "<EXTREMELY_IMPORTANT>",
  "You have superpowers",
  "Below is the full content of your",
];

export function isTranscriptBoilerplate(text: string): boolean {
  const line = normalizePreviewLine(text);
  if (!line) {
    return true;
  }
  for (const prefix of BOILERPLATE_PREFIXES) {
    if (line.startsWith(prefix)) {
      return true;
    }
  }
  const nonSpace = line.replace(/\s/g, "");
  if (!nonSpace) {
    return true;
  }
  const tagMatches = line.match(/<[^>]+>/g) ?? [];
  const tagChars = tagMatches.join("").replace(/\s/g, "").length;
  if (tagChars / nonSpace.length > 0.5) {
    return true;
  }
  return false;
}

export function firstMeaningfulTranscriptTitle(
  transcriptContent: string,
  conversationId: string
): string | null {
  const userSnippets: string[] = [];
  const anySnippets: string[] = [];

  for (const rawLine of transcriptContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsedLine: Record<string, unknown>;
    try {
      parsedLine = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role =
      typeof parsedLine.role === "string" ? parsedLine.role.trim().toLowerCase() : "";
    for (const snippet of collectTranscriptSnippets(parsedLine)) {
      const normalized = normalizePreviewLine(snippet);
      if (!normalized || isTranscriptBoilerplate(normalized)) {
        continue;
      }
      anySnippets.push(normalized);
      if (role === "user") {
        userSnippets.push(normalized);
      }
    }
  }

  const first = userSnippets[0] ?? anySnippets[0];
  return first ? truncateText(first, 96) : null;
}

export function resolveConversationDisplayTitle(options: {
  conversationId: string;
  composerName?: string | null;
  transcriptContent?: string | null;
}): string {
  const trimmed = options.composerName?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (options.transcriptContent) {
    const fromTranscript = firstMeaningfulTranscriptTitle(
      options.transcriptContent,
      options.conversationId
    );
    if (fromTranscript) {
      return fromTranscript;
    }
  }
  return options.conversationId;
}

function collectTranscriptSnippets(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTranscriptSnippets(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const prioritizedKeys = [
    "text",
    "content",
    "message",
    "reasoning",
    "input",
    "output",
    "toolName",
    "name",
  ];
  const snippets: string[] = [];

  for (const key of prioritizedKeys) {
    if (key in record) {
      snippets.push(...collectTranscriptSnippets(record[key]));
    }
  }

  return snippets;
}

function getTimestampCandidate(record: Record<string, unknown>): string | undefined {
  const keys = ["timestamp", "createdAt", "updatedAt", "lastUpdatedAt"];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizePreviewLine(value: string): string {
  const collapsed = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^<[^>]+>$/.test(line))
    .join(" ");

  return collapsed.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return decoded !== undefined;
  } catch {
    return false;
  }
}
