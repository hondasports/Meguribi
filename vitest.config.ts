import { defineConfig } from "vitest/config";
import path from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@meguribi/core": path.resolve(root, "packages/core/src/index.ts"),
      "@meguribi/process": path.resolve(root, "packages/process/src/index.ts"),
      "@meguribi/schemas": path.resolve(root, "packages/schemas/src/index.ts"),
      "@meguribi/config": path.resolve(root, "packages/config/src/index.ts"),
      "@meguribi/adapters": path.resolve(root, "packages/adapters/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
