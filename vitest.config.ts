import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    // Scoped to our own source. Without this, discovery walks `.cache/` and
    // picks up ~144 test files that ship inside cached dependencies, which
    // fail for reasons that have nothing to do with this project and bury the
    // real results.
    include: ["{server,shared,client}/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", ".cache/**", ".local/**"],
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
      "@": path.resolve(__dirname, "client/src"),
    },
  },
});
