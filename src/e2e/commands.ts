import * as vscode from "vscode";
import {
  computeDekVerifierHex,
  generateDek,
  generateSalt,
  unwrapDekWithPassphrase,
  unwrapDekWithRecoveryKey,
  wrapDekForPassphrase,
  wrapDekForRecovery,
} from "./key-material.js";
import { DEFAULT_ARGON2_PARAMS, MIN_PASSPHRASE_LENGTH } from "./constants.js";
import {
  buildPutKeysBody,
  fetchServerKeyMaterial,
  getCachedKeysGate,
  hydrateKeysCacheFromDisk,
  invalidateKeysGateCache,
  KeysApiError,
  putServerKeyMaterial,
  rewrapPassphraseOnServer,
  rotateRecoveryOnServer,
} from "./keys-client.js";
import { rememberDekVersion, storeDek } from "./dek-storage.js";
import {
  formatRecoveryKeyForDisplay,
  generateRecoveryKeyBytes,
  lastRecoveryKeyGroup,
  parseRecoveryKeyInput,
} from "./recovery-key.js";
import {
  refreshE2eGateAfterCryptoChange,
  refreshE2eGateContext,
  lockLocalDek,
  resolveE2eGateSnapshot,
  invalidateE2eGateSnapshot,
  isE2eDekUnlocked,
  requireE2eUnlocked,
} from "./gate.js";
import { parseAppSessionClaims } from "./session-user.js";
import { getAppSession } from "../app-auth.js";
import { markMigrationPending } from "./migration.js";
import { refreshSidebar } from "../sidebar/index.js";

function keysApiUserMessage(err: unknown): string {
  if (err instanceof KeysApiError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function ensureEmailVerifiedForSetup(
  context: vscode.ExtensionContext
): Promise<boolean> {
  try {
    const cache = await fetchServerKeyMaterial(context, { force: true });
    if (cache.verification === "email_not_verified") {
      vscode.window.showErrorMessage(
        "Verify your email on the Cursor Sync website, then use “I verified, re-check” in the sidebar."
      );
      return false;
    }
    return true;
  } catch (err) {
    vscode.window.showErrorMessage(keysApiUserMessage(err));
    return false;
  }
}

export async function runRecheckEmailVerification(
  context: vscode.ExtensionContext
): Promise<void> {
  invalidateE2eGateSnapshot();
  await invalidateKeysGateCache(context);
  try {
    const cache = await fetchServerKeyMaterial(context, { force: true });
    if (cache.verification === "email_not_verified") {
      vscode.window.showWarningMessage(
        "Email is still not verified. Complete verification on the Cursor Sync website and try again."
      );
      await refreshE2eGateAfterCryptoChange(context, { refreshKeys: true });
      refreshSidebar();
      return;
    }
    await refreshE2eGateAfterCryptoChange(context, { refreshKeys: true });
    refreshSidebar();
    vscode.window.showInformationMessage("Email verification confirmed.");
  } catch (err) {
    vscode.window.showErrorMessage(keysApiUserMessage(err));
  }
}

async function rewrapDekWithNewPassphrase(
  context: vscode.ExtensionContext,
  dek: Buffer,
  userId: string,
  keyVersion: number
): Promise<boolean> {
  const newPass = await promptPassphrase("Set a new sync passphrase (required after recovery unlock)");
  if (!newPass) {
    return false;
  }
  const confirm = await promptPassphrase("Confirm new sync passphrase");
  if (!confirm || confirm !== newPass) {
    vscode.window.showErrorMessage("Passphrases do not match.");
    return false;
  }
  const salt = generateSalt();
  const kdfParams = { ...DEFAULT_ARGON2_PARAMS };
  const passWrapResult = await wrapDekForPassphrase(
    dek,
    newPass,
    userId,
    keyVersion,
    salt,
    kdfParams
  );
  try {
    await rewrapPassphraseOnServer(context, {
      keyVersion,
      dekVerifier: computeDekVerifierHex(dek),
      kdfParams: passWrapResult.kdfParams,
      salt: passWrapResult.salt.toString("base64"),
      passWrap: {
        nonce: passWrapResult.wrap.nonce.toString("base64"),
        ct: passWrapResult.wrap.ct.toString("base64"),
      },
    });
  } catch (err) {
    vscode.window.showErrorMessage(keysApiUserMessage(err));
    return false;
  }
  return true;
}

async function promptPassphrase(label: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: label,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().length < MIN_PASSPHRASE_LENGTH) {
        return `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`;
      }
      return undefined;
    },
  });
}

export async function runCreatePassphraseFlow(context: vscode.ExtensionContext): Promise<boolean> {
  const warned = await vscode.window.showWarningMessage(
    "If you lose both your passphrase and recovery key, your synced data cannot be recovered. Not even the Cursor Sync team can recover it.",
    { modal: true },
    "Continue"
  );
  if (warned !== "Continue") {
    return false;
  }

  const passphrase = await promptPassphrase("Create sync passphrase");
  if (!passphrase) {
    return false;
  }
  const confirm = await promptPassphrase("Confirm sync passphrase");
  if (!confirm || confirm !== passphrase) {
    vscode.window.showErrorMessage("Passphrases do not match.");
    return false;
  }

  const session = await getAppSession(context);
  const claims = session ? parseAppSessionClaims(session) : undefined;
  if (!claims?.userId) {
    vscode.window.showErrorMessage("Log in to Cursor Sync before creating a sync passphrase.");
    return false;
  }
  if (!(await ensureEmailVerifiedForSetup(context))) {
    return false;
  }

  const dek = generateDek();
  const salt = generateSalt();
  const keyVersion = 1;
  const kdfParams = { ...DEFAULT_ARGON2_PARAMS };
  const passWrapResult = await wrapDekForPassphrase(dek, passphrase, claims.userId, keyVersion, salt, kdfParams);
  const recoveryBytes = generateRecoveryKeyBytes();
  const recoveryWrap = wrapDekForRecovery(dek, recoveryBytes, claims.userId, keyVersion);
  const dekVerifier = computeDekVerifierHex(dek);

  const formattedRecovery = formatRecoveryKeyForDisplay(recoveryBytes);
  const lastGroup = lastRecoveryKeyGroup(formattedRecovery);

  const panel = await vscode.window.showInformationMessage(
    `Save this recovery key now. It will not be shown again:\n\n${formattedRecovery}`,
    { modal: true },
    "Copy",
    "Save to file"
  );
  if (panel === "Copy") {
    await vscode.env.clipboard.writeText(formattedRecovery);
  } else if (panel === "Save to file") {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("cursor-sync-recovery-key.txt"),
      filters: { Text: ["txt"] },
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(formattedRecovery, "utf8"));
    }
  }

  const typed = await vscode.window.showInputBox({
    prompt: `Type the last group of your recovery key to confirm you saved it (${lastGroup})`,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value?.trim().toUpperCase() === lastGroup.toUpperCase()
        ? undefined
        : "Does not match the last group",
  });
  if (!typed) {
    return false;
  }

  try {
    await putServerKeyMaterial(
      context,
      buildPutKeysBody(
        1,
        passWrapResult.salt,
        passWrapResult.kdfParams,
        passWrapResult.wrap,
        recoveryWrap,
        dekVerifier
      )
    );
  } catch (err) {
    if (err instanceof KeysApiError && err.code === "KEYS_ALREADY_SET") {
      await invalidateKeysGateCache(context);
      await refreshE2eGateAfterCryptoChange(context, { refreshKeys: true });
      return runUnlockFlow(context);
    }
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(message);
    return false;
  }

  await storeDek(context, claims.userId, keyVersion, dek);
  await rememberDekVersion(context, claims.userId, keyVersion);
  await markMigrationPending(context);
  await refreshE2eGateAfterCryptoChange(context, { refreshKeys: true });
  refreshSidebar();
  vscode.window.showInformationMessage("Sync encryption is ready. Your next push will encrypt existing data.");
  return true;
}

export async function runUnlockFlow(context: vscode.ExtensionContext): Promise<boolean> {
  let snapshot: Awaited<ReturnType<typeof resolveE2eGateSnapshot>>;
  try {
    snapshot = await resolveE2eGateSnapshot(context, { refreshKeys: true, bypassCache: true });
  } catch (err) {
    vscode.window.showErrorMessage(keysApiUserMessage(err));
    return false;
  }
  if (snapshot.phase === "keys_not_set") {
    return runCreatePassphraseFlow(context);
  }
  if (snapshot.phase !== "locked" || !snapshot.userId || !snapshot.keyVersion) {
    vscode.window.showInformationMessage("Sync is not locked.");
    return snapshot.phase === "unlocked";
  }

  const useRecovery = await vscode.window.showQuickPick(
    [
      { label: "Passphrase", id: "pass" },
      { label: "Use recovery key", id: "recovery" },
    ],
    { title: "Unlock encrypted sync" }
  );
  if (!useRecovery) {
    return false;
  }

  await hydrateKeysCacheFromDisk(context);
  let keysCache = getCachedKeysGate();
  if (!keysCache.keyMaterial) {
    try {
      keysCache = await fetchServerKeyMaterial(context);
    } catch (err) {
      vscode.window.showErrorMessage(keysApiUserMessage(err));
      return false;
    }
  }
  const material = keysCache.keyMaterial;
  if (!material) {
    vscode.window.showErrorMessage("Could not load encryption keys from the server.");
    return false;
  }

  let dek: Buffer | undefined;
  let usedRecovery = false;
  if (useRecovery.id === "recovery") {
    const input = await vscode.window.showInputBox({
      prompt: "Enter recovery key",
      password: true,
      ignoreFocusOut: true,
    });
    if (!input) {
      return false;
    }
    try {
      const bytes = parseRecoveryKeyInput(input);
      dek = unwrapDekWithRecoveryKey(
        material.recoveryWrap,
        bytes,
        snapshot.userId,
        material.keyVersion
      );
      usedRecovery = true;
    } catch (err) {
      vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      return false;
    }
  } else {
    const passphrase = await promptPassphrase("Enter sync passphrase");
    if (!passphrase) {
      return false;
    }
    try {
      dek = await unwrapDekWithPassphrase(
        material.passWrap,
        passphrase,
        snapshot.userId,
        material.keyVersion,
        material.salt,
        material.kdfParams
      );
    } catch {
      vscode.window.showErrorMessage("Wrong passphrase.");
      return false;
    }
  }

  if (usedRecovery) {
    const rewrapped = await rewrapDekWithNewPassphrase(
      context,
      dek,
      snapshot.userId,
      material.keyVersion
    );
    if (!rewrapped) {
      return false;
    }
  }

  await storeDek(context, snapshot.userId, material.keyVersion, dek);
  await rememberDekVersion(context, snapshot.userId, material.keyVersion);
  await markMigrationPending(context);
  await refreshE2eGateAfterCryptoChange(context);
  refreshSidebar();
  vscode.window.showInformationMessage("Sync unlocked.");
  return true;
}

export async function executeE2eLock(context: vscode.ExtensionContext): Promise<void> {
  await lockLocalDek(context);
  refreshSidebar();
  vscode.window.showInformationMessage("Sync locked on this device.");
}

export async function executeE2eUnlock(context: vscode.ExtensionContext): Promise<void> {
  await runUnlockFlow(context);
}

export async function executeE2eChangePassphrase(context: vscode.ExtensionContext): Promise<void> {
  const unlocked = await requireE2eUnlocked(context);
  if (!isE2eDekUnlocked(unlocked)) {
    vscode.window.showErrorMessage(unlocked.ok ? "Unlock sync first." : unlocked.message);
    return;
  }

  const keysCache = await fetchServerKeyMaterial(context, { force: true });
  const material = keysCache.keyMaterial;
  if (!material) {
    return;
  }

  const newPass = await promptPassphrase("New sync passphrase");
  if (!newPass) {
    return;
  }
  const confirm = await promptPassphrase("Confirm new sync passphrase");
  if (!confirm || confirm !== newPass) {
    vscode.window.showErrorMessage("Passphrases do not match.");
    return;
  }

  const salt = generateSalt();
  const kdfParams = { ...DEFAULT_ARGON2_PARAMS };
  const passWrapResult = await wrapDekForPassphrase(
    unlocked.dek,
    newPass,
    unlocked.userId,
    material.keyVersion,
    salt,
    kdfParams
  );

  try {
    await rewrapPassphraseOnServer(context, {
      keyVersion: material.keyVersion,
      dekVerifier: computeDekVerifierHex(unlocked.dek),
      kdfParams: passWrapResult.kdfParams,
      salt: passWrapResult.salt.toString("base64"),
      passWrap: {
        nonce: passWrapResult.wrap.nonce.toString("base64"),
        ct: passWrapResult.wrap.ct.toString("base64"),
      },
    });
  } catch (err) {
    vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    return;
  }

  await refreshE2eGateAfterCryptoChange(context, { refreshKeys: true });
  refreshSidebar();
  vscode.window.showInformationMessage("Sync passphrase changed.");
}

export async function executeE2eRotateRecoveryKey(context: vscode.ExtensionContext): Promise<void> {
  const unlocked = await requireE2eUnlocked(context);
  if (!isE2eDekUnlocked(unlocked)) {
    vscode.window.showErrorMessage(unlocked.ok ? "Unlock sync first." : unlocked.message);
    return;
  }

  const keysCache = await fetchServerKeyMaterial(context, { force: true });
  const material = keysCache.keyMaterial;
  if (!material) {
    return;
  }

  const recoveryBytes = generateRecoveryKeyBytes();
  const recoveryWrap = wrapDekForRecovery(
    unlocked.dek,
    recoveryBytes,
    unlocked.userId,
    material.keyVersion
  );
  const formattedRecovery = formatRecoveryKeyForDisplay(recoveryBytes);
  const lastGroup = lastRecoveryKeyGroup(formattedRecovery);

  const panel = await vscode.window.showInformationMessage(
    `New recovery key (shown once):\n\n${formattedRecovery}`,
    { modal: true },
    "Copy",
    "Save to file"
  );
  if (panel === "Copy") {
    await vscode.env.clipboard.writeText(formattedRecovery);
  } else if (panel === "Save to file") {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("cursor-sync-recovery-key.txt"),
      filters: { Text: ["txt"] },
    });
    if (uri) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(formattedRecovery, "utf8"));
    }
  }

  const typed = await vscode.window.showInputBox({
    prompt: `Type the last group to confirm (${lastGroup})`,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value?.trim().toUpperCase() === lastGroup.toUpperCase()
        ? undefined
        : "Does not match the last group",
  });
  if (!typed) {
    return;
  }

  try {
    await rotateRecoveryOnServer(context, {
      keyVersion: material.keyVersion,
      dekVerifier: computeDekVerifierHex(unlocked.dek),
      recoveryWrap: {
        nonce: recoveryWrap.nonce.toString("base64"),
        ct: recoveryWrap.ct.toString("base64"),
      },
    });
  } catch (err) {
    vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
    return;
  }

  await refreshE2eGateAfterCryptoChange(context, { refreshKeys: true });
  refreshSidebar();
  vscode.window.showInformationMessage("Recovery key rotated.");
}

export async function ensureE2eGateAfterLogin(context: vscode.ExtensionContext): Promise<void> {
  const snapshot = await refreshE2eGateAfterCryptoChange(context, { refreshKeys: true });
  if (snapshot.phase === "keys_not_set") {
    void runCreatePassphraseFlow(context);
  } else if (snapshot.phase === "locked") {
    void vscode.window.showInformationMessage(
      "Encrypted sync is locked on this device.",
      "Unlock"
    ).then((action) => {
      if (action === "Unlock") {
        void runUnlockFlow(context);
      }
    });
  }
}
