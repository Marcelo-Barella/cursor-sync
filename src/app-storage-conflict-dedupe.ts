let lastConflictSignature: string | undefined;

export function resetConflictWarningDedupe(): void {
  lastConflictSignature = undefined;
}

export function shouldRecordConflictWarning(keys: string[]): boolean {
  const signature = [...keys].sort().join("\0");
  if (signature === lastConflictSignature) {
    return false;
  }
  lastConflictSignature = signature;
  return true;
}

export function clearConflictWarningIfResolved(): void {
  lastConflictSignature = undefined;
}
