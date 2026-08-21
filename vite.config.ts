import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

/**
 * Replit's editor plugins (error overlay, cartographer, dev banner) are loaded
 * only inside a Replit workspace, and imported dynamically so the build does
 * not need them to be installed at all. Without that, `npm run build` on any
 * other host fails at config load on a missing @replit/* package.
 */
async function replitDevPlugins(): Promise<PluginOption[]> {
  if (process.env.REPL_ID === undefined || process.env.NODE_ENV === "production") {
    return [];
  }

  const [errorModal, cartographer, devBanner] = await Promise.all([
    import("@replit/vite-plugin-runtime-error-modal"),
    import("@replit/vite-plugin-cartographer"),
    import("@replit/vite-plugin-dev-banner"),
  ]);

  return [errorModal.default(), cartographer.cartographer(), devBanner.devBanner()];
}

// Passed as a promise rather than awaited here: Vite resolves promises in the
// plugin list, and this keeps the export a plain object, which server/vite.ts
// spreads when starting the dev server in middleware mode.
export default defineConfig({
  plugins: [react(), replitDevPlugins()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
});
