import { defineConfig } from "vitest/config";
import path from "path";
import { fileURLToPath } from "url";

// `__dirname` does not exist in an ES module, and Vite's native config loader
// no longer shims it.
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    // Scoped to our own source. Without this, discovery walks `.cache/` and
    // picks up ~144 test files that ship inside cached dependencies, which
    // fail for reasons that have nothing to do with this project and bury the
    // real results.
    include: ["{server,shared,client,scripts}/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", ".cache/**", ".local/**"],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(rootDir, "shared"),
      "@": path.resolve(rootDir, "client/src"),
    },
  },
});
