import { afterEach, beforeEach, vi } from "vitest";

let unhandledRejections: unknown[] = [];

beforeEach(() => {
  unhandledRejections = [];
});

afterEach(() => {
  if (unhandledRejections.length > 0) {
    throw new Error(
      `Unhandled rejection(s) during test: ${unhandledRejections
        .map((r) => (r instanceof Error ? r.message : String(r)))
        .join("; ")}`
    );
  }
});

process.on("unhandledRejection", (reason) => {
  unhandledRejections.push(reason);
});
