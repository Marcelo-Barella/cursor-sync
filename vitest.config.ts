import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, "tests/__mocks__/vscode.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
  },
});
