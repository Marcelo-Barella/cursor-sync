#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export SQL_CF_FUZZ_COUNT=50000
npm run build
npx vitest run tests/sqlite-script-safety-cf.test.ts -t "cf differential property"
