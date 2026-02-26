import * as vscode from "vscode";
import { executePush, isPushLocked } from "./push.js";
import { getLogger } from "./diagnostics.js";

const MIN_INTERVAL_MINUTES = 5;
const MAX_JITTER_MS = 60_000;

let timer: ReturnType<typeof setInterval> | undefined;
let jitterTimeout: ReturnType<typeof setTimeout> | undefined;

export function startScheduler(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("cursorSync");
  const enabled = config.get<boolean>("schedule.enabled") ?? false;

  if (!enabled) {
    return;
  }

  const intervalMin = Math.max(
    config.get<number>("schedule.intervalMin") ?? 30,
    MIN_INTERVAL_MINUTES
  );
  const intervalMs = intervalMin * 60 * 1000;
  const jitter = Math.floor(Math.random() * MAX_JITTER_MS);

  const logger = getLogger();
  logger.appendLine(
    `[${new Date().toISOString()}] Scheduler starting: interval=${intervalMin}min, jitter=${jitter}ms`
  );

  jitterTimeout = setTimeout(() => {
    scheduledTick(context);
    timer = setInterval(() => scheduledTick(context), intervalMs);
  }, jitter);
}

export function stopScheduler(): void {
  if (jitterTimeout) {
    clearTimeout(jitterTimeout);
    jitterTimeout = undefined;
  }
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

async function scheduledTick(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();

  if (isPushLocked()) {
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync skipped: operation in progress`
    );
    return;
  }

  logger.appendLine(
    `[${new Date().toISOString()}] Scheduled sync triggered`
  );

  try {
    await executePush(context);
  } catch (err) {
    logger.appendLine(
      `[${new Date().toISOString()}] Scheduled sync failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
