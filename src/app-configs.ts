import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getAppSession } from "./app-auth.js";
import { getAppApiUrl } from "./config/urls.js";
import { appApiAuthHeaders } from "./app-api-http.js";
import {
  getR2Object,
  getR2StorageCredentials,
} from "./app-r2-storage.js";
import { requireE2eUnlocked } from "./e2e/gate.js";
import {
  decryptManifestPayload,
  encryptManifestPayload,
  fetchConfigsApi,
  putConfigsManifestWithRetry,
} from "./e2e/configs-sync.js";
import { deletePlaintextR2Objects } from "./e2e/storage-plaintext.js";
import { putEncryptedR2Object, getEncryptedR2Object } from "./e2e/r2-storage.js";
import { loadMigrationState, saveMigrationState, tryCompleteMigration } from "./e2e/migration.js";
import type { E2eConfigsManifestPayload } from "./e2e/manifest-payload.js";
import { generateExtensionsJson } from "./extensions.js";
import { getLogger } from "./diagnostics.js";
import { enumerateSyncFiles, resolveSyncRoots } from "./paths.js";
import { packageFiles } from "./packaging.js";
import { createBackup, pruneOldBackups, rollbackFromBackup } from "./rollback.js";
import type { Manifest, ManifestFileEntry } from "./types.js";

export const APP_CONFIGS_PAYLOAD_SCHEMA_VERSION = 1 as const;

export interface AppConfigsPayloadFile {
  content?: string;
  encoding?: "base64";
  checksum?: string;
  sizeBytes?: number;
}

export interface AppConfigsPayloadV1 {
  schemaVersion: typeof APP_CONFIGS_PAYLOAD_SCHEMA_VERSION;
  manifest: Manifest;
  files: Record<string, AppConfigsPayloadFile>;
}

export interface AppConfigsResponse {
  payload?: AppConfigsPayloadV1 | null;
  encryptedManifest?: string | null;
  manifestVersion?: number;
  updated_at: string;
}

const LOGIN_REQUIRED_MESSAGE = "Log in to Cursor Sync to sync configs with the app.";

export async function hasAppSession(
  context: vscode.ExtensionContext
): Promise<boolean> {
  return !!(await getAppSession(context));
}

export async function requireAppSession(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const session = await getAppSession(context);
  if (!session) {
    vscode.window.showErrorMessage(LOGIN_REQUIRED_MESSAGE);
    return undefined;
  }
  return session;
}

function appConfigsBaseUrl(): string {
  return getAppApiUrl();
}

export async function fetchAppConfigs(
  context: vscode.ExtensionContext
): Promise<AppConfigsResponse | undefined> {
  const session = await requireAppSession(context);
  if (!session) {
    return undefined;
  }

  const response = await fetch(`${appConfigsBaseUrl()}/configs`, {
    method: "GET",
    headers: appApiAuthHeaders(session),
  });

  if (response.status === 401) {
    vscode.window.showErrorMessage(LOGIN_REQUIRED_MESSAGE);
    return undefined;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch app configs (${response.status})${text ? `: ${text}` : ""}`
    );
  }

  return (await response.json()) as AppConfigsResponse;
}

export async function putAppConfigs(
  context: vscode.ExtensionContext,
  payload: AppConfigsPayloadV1
): Promise<AppConfigsResponse | undefined> {
  const session = await requireAppSession(context);
  if (!session) {
    return undefined;
  }

  const response = await fetch(`${appConfigsBaseUrl()}/configs`, {
    method: "PUT",
    headers: {
      ...appApiAuthHeaders(session),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ payload }),
  });

  if (response.status === 401) {
    vscode.window.showErrorMessage(LOGIN_REQUIRED_MESSAGE);
    return undefined;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Failed to push app configs (${response.status})${text ? `: ${text}` : ""}`
    );
  }

  return (await response.json()) as AppConfigsResponse;
}

export function buildMetadataOnlyPayload(
  manifest: Manifest,
  files: Record<string, AppConfigsPayloadFile>
): AppConfigsPayloadV1 {
  const metadataFiles: Record<string, AppConfigsPayloadFile> = {};
  for (const [syncKey, manifestEntry] of Object.entries(manifest.files)) {
    const source = files[syncKey];
    metadataFiles[syncKey] = {
      checksum: source?.checksum ?? manifestEntry.checksum,
      sizeBytes: source?.sizeBytes ?? manifestEntry.sizeBytes,
      ...(manifestEntry.encoding ? { encoding: manifestEntry.encoding } : {}),
    };
  }

  return {
    schemaVersion: APP_CONFIGS_PAYLOAD_SCHEMA_VERSION,
    manifest,
    files: metadataFiles,
  };
}

export async function buildLocalAppConfigsPayload(): Promise<AppConfigsPayloadV1> {
  const extensionsJson = generateExtensionsJson();
  const cursorUserRoot = resolveSyncRoots().cursorUser;
  const extensionsPath = path.join(cursorUserRoot, "extensions.json");
  await fs.mkdir(path.dirname(extensionsPath), { recursive: true });
  await fs.writeFile(extensionsPath, extensionsJson, "utf-8");

  const files = await enumerateSyncFiles();
  const config = vscode.workspace.getConfiguration("cursorSync");
  const profileName = config.get<string>("syncProfileName") ?? "default";
  const { packaged, manifest } = await packageFiles(files, profileName);

  const payloadFiles: Record<string, AppConfigsPayloadFile> = {};
  for (const [syncKey, entry] of packaged) {
    payloadFiles[syncKey] = {
      content: entry.content,
      checksum: entry.checksum,
      sizeBytes: entry.sizeBytes,
      ...(entry.encoding ? { encoding: entry.encoding } : {}),
    };
  }

  return {
    schemaVersion: APP_CONFIGS_PAYLOAD_SCHEMA_VERSION,
    manifest,
    files: payloadFiles,
  };
}

function syncKeyToAbsolutePath(
  syncKey: string,
  roots: { cursorUser: string; dotCursor: string }
): string | undefined {
  if (syncKey.startsWith("cursor-user/")) {
    const rel = syncKey.slice("cursor-user/".length);
    return path.join(roots.cursorUser, ...rel.split("/"));
  }

  if (syncKey.startsWith("dot-cursor/")) {
    const rel = syncKey.slice("dot-cursor/".length);
    return path.join(roots.dotCursor, ...rel.split("/"));
  }

  return undefined;
}

function decodePayloadFileContent(
  file: AppConfigsPayloadFile,
  manifestEntry: ManifestFileEntry
): Buffer | undefined {
  if (file.content === undefined) {
    return undefined;
  }
  if (manifestEntry.encoding === "base64" || file.encoding === "base64") {
    return Buffer.from(file.content, "base64");
  }
  return Buffer.from(file.content, "utf-8");
}

async function resolveRemoteFileContent(
  context: vscode.ExtensionContext,
  syncKey: string,
  file: AppConfigsPayloadFile,
  manifestEntry: ManifestFileEntry,
  e2e?: { dek: Buffer; userId: string; keyVersion: number }
): Promise<Buffer | undefined> {
  const credentials = await getR2StorageCredentials(context);
  if (credentials && e2e) {
    const remote = await getEncryptedR2Object(
      credentials,
      e2e.dek,
      e2e.userId,
      e2e.keyVersion,
      syncKey
    );
    if (remote) {
      return remote;
    }
  } else if (credentials) {
    const remote = await getR2Object(credentials, syncKey);
    if (remote) {
      return remote;
    }
  }

  return decodePayloadFileContent(file, manifestEntry);
}

function isAppConfigsPayloadV1(value: unknown): value is AppConfigsPayloadV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as AppConfigsPayloadV1;
  return (
    candidate.schemaVersion === APP_CONFIGS_PAYLOAD_SCHEMA_VERSION &&
    typeof candidate.manifest === "object" &&
    candidate.manifest !== null &&
    typeof candidate.files === "object" &&
    candidate.files !== null
  );
}

export async function executePushAppConfigs(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Push app configs started`);

  const e2e = await requireE2eUnlocked(context);
  if (!e2e.ok) {
    vscode.window.showErrorMessage(e2e.message);
    return false;
  }

  try {
    const localPayload = await buildLocalAppConfigsPayload();
    const credentials = await getR2StorageCredentials(context);
    if (!credentials) {
      return false;
    }

    const migration = await loadMigrationState(context);
    const metadataFiles: Record<string, AppConfigsPayloadFile> = {};
    const plaintextKeysToDelete: string[] = [];

    for (const [syncKey, file] of Object.entries(localPayload.files)) {
      const manifestEntry = localPayload.manifest.files[syncKey];
      if (!manifestEntry || file.content === undefined) {
        continue;
      }
      const encoding =
        manifestEntry.encoding === "base64" || file.encoding === "base64"
          ? "base64"
          : "utf-8";
      const body =
        encoding === "base64"
          ? Buffer.from(file.content, "base64")
          : Buffer.from(file.content, "utf-8");

      await putEncryptedR2Object(
        credentials,
        e2e.dek,
        e2e.userId,
        e2e.keyVersion,
        syncKey,
        body
      );
      plaintextKeysToDelete.push(syncKey);
      metadataFiles[syncKey] = {
        checksum: file.checksum ?? manifestEntry.checksum,
        sizeBytes: file.sizeBytes ?? manifestEntry.sizeBytes,
        ...(manifestEntry.encoding ? { encoding: manifestEntry.encoding } : {}),
      };
    }

    const manifestPayload: E2eConfigsManifestPayload = {
      schemaVersion: 1,
      manifest: localPayload.manifest,
      files: metadataFiles,
    };

    const hadLegacyPayload = Boolean((await fetchConfigsApi(context))?.payload);
    const clearLegacyPayload = hadLegacyPayload || (migration && migration.phase !== "completed");

    await putConfigsManifestWithRetry(context, (expectedManifestVersion) => ({
      manifestCiphertext: encryptManifestPayload(
        e2e.dek,
        e2e.userId,
        e2e.keyVersion,
        manifestPayload
      ),
      expectedManifestVersion,
      ...(clearLegacyPayload ? { clearLegacyPayload: true } : {}),
    }));

    if (migration && migration.phase !== "completed") {
      const completed = new Set(migration.completedPlaintextR2Keys);
      const pending = plaintextKeysToDelete.filter((k) => !completed.has(k));
      if (pending.length > 0) {
        try {
          const deleted = await deletePlaintextR2Objects(context, pending);
          for (const key of deleted) {
            completed.add(key);
          }
        } catch (err) {
          logger.appendLine(
            `[${new Date().toISOString()}] Migration: plaintext R2 delete API failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      await saveMigrationState(context, {
        phase: "in_progress",
        completedPlaintextR2Keys: [...completed],
        completedPlaintextGistFiles: migration.completedPlaintextGistFiles,
      });
    }

    const fileCount = Object.keys(metadataFiles).length;
    vscode.window.showInformationMessage(
      `App configs push complete: ${fileCount} file(s) synced.`
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs succeeded: ${fileCount} files`
    );
    await tryCompleteMigration(context, "app");
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Push app configs failed: ${message}`
    );
    vscode.window.showErrorMessage(`Push app configs failed: ${message}`);
    return false;
  }
}

export async function executePullAppConfigs(
  context: vscode.ExtensionContext
): Promise<boolean> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Pull app configs started`);

  const e2e = await requireE2eUnlocked(context);
  if (!e2e.ok) {
    vscode.window.showErrorMessage(e2e.message);
    return false;
  }

  try {
    const remote = await fetchConfigsApi(context);
    if (!remote?.manifestCiphertext) {
      if (!remote?.payload || !isAppConfigsPayloadV1(remote.payload as AppConfigsPayloadV1)) {
        vscode.window.showInformationMessage("Pull app configs complete: no remote configs.");
        return true;
      }
      vscode.window.showWarningMessage(
        "Remote configs are not encrypted yet. Push from an unlocked client to migrate."
      );
      return false;
    }

    const decrypted = decryptManifestPayload(
      e2e.dek,
      e2e.userId,
      e2e.keyVersion,
      remote.manifestCiphertext
    );
    const { manifest, files } = decrypted;
    const roots = resolveSyncRoots();
    const filesToWrite: Array<{ absolutePath: string; syncKey: string; content: Buffer }> =
      [];

    for (const [syncKey, file] of Object.entries(files)) {
      const manifestEntry = manifest.files[syncKey];
      if (!manifestEntry) {
        continue;
      }

      const absolutePath = syncKeyToAbsolutePath(syncKey, roots);
      if (!absolutePath) {
        continue;
      }

      const content = await resolveRemoteFileContent(
        context,
        syncKey,
        file,
        manifestEntry,
        e2e
      );
      if (!content) {
        continue;
      }

      filesToWrite.push({
        absolutePath,
        syncKey,
        content,
      });
    }

    const config = vscode.workspace.getConfiguration("cursorSync");
    const safeMode = config.get<boolean>("safeMode") ?? true;

    if (safeMode && filesToWrite.length > 0) {
      const items = filesToWrite.map((f) => ({
        label: f.syncKey,
        picked: true,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: "App configs files to overwrite",
        placeHolder: "Deselect files you do not want to overwrite",
      });

      if (!selected) {
        logger.appendLine(`[${new Date().toISOString()}] Pull app configs cancelled by user`);
        return false;
      }

      const selectedKeys = new Set(selected.map((s) => s.label));
      const filtered = filesToWrite.filter((f) => selectedKeys.has(f.syncKey));
      filesToWrite.length = 0;
      filesToWrite.push(...filtered);
    }

    if (filesToWrite.length === 0) {
      vscode.window.showInformationMessage("Pull app configs complete: no files to update.");
      logger.appendLine(
        `[${new Date().toISOString()}] Pull app configs succeeded: 0 files`
      );
      return true;
    }

    const { entries: backupEntries } = await createBackup(
      context,
      filesToWrite.map((f) => f.absolutePath)
    );

    const writtenBackups: typeof backupEntries = [];
    for (const file of filesToWrite) {
      try {
        const dir = path.dirname(file.absolutePath);
        await fs.mkdir(dir, { recursive: true });
        const tmpPath = file.absolutePath + ".tmp";
        await fs.writeFile(tmpPath, file.content);
        await fs.rename(tmpPath, file.absolutePath);
        const backup = backupEntries.find((b) => b.absolutePath === file.absolutePath);
        if (backup) {
          writtenBackups.push(backup);
        }
      } catch (err) {
        logger.appendLine(
          `[${new Date().toISOString()}] Pull app configs write failed for ${file.absolutePath}: ${err instanceof Error ? err.message : String(err)}`
        );
        await rollbackFromBackup(writtenBackups);
        vscode.window.showErrorMessage(
          "Pull app configs failed: file write error. Changes have been rolled back."
        );
        return false;
      }
    }

    await pruneOldBackups(context);

    vscode.window.showInformationMessage(
      `Pull app configs complete: ${filesToWrite.length} file(s) updated.`
    );
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs succeeded: ${filesToWrite.length} files`
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.appendLine(
      `[${new Date().toISOString()}] Pull app configs failed: ${message}`
    );
    vscode.window.showErrorMessage(`Pull app configs failed: ${message}`);
    return false;
  }
}
