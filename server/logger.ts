/**
 * Console logging shared by the whole server.
 *
 * Kept apart from server/vite.ts on purpose. That module imports Vite itself,
 * which is a build-time tool and not installed in a production-only dependency
 * install -- so anything importing this from the production entry point would
 * drag Vite into the runtime and the service would fail to start.
 */
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}
