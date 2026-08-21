import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { logError } from "./errors";

const { Pool } = pg;

/**
 * A standard PostgreSQL connection, so the same code runs against Supabase,
 * Render's managed Postgres, or a database on a laptop. The only input is an
 * ordinary connection string.
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL must be set to a PostgreSQL connection string, for example " +
      "postgresql://user:password@host:5432/database",
  );
}

function isLocalConnection(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

/**
 * Encryption is on by default for anything that is not on this machine, because
 * the connection carries credentials and resident data across a network we do
 * not control. `DATABASE_SSL` is the escape hatch:
 *
 *   require     encrypt and verify the server's certificate (the default)
 *   no-verify   encrypt but skip verification -- only for a provider whose
 *               certificate is signed by its own authority, and only knowingly
 *   disable     no encryption; appropriate for a database on this machine
 *
 * Setting this explicitly also overrides any `sslmode` in the connection string,
 * so the deployment configuration has the final say.
 */
function resolveSsl(url: string): pg.PoolConfig["ssl"] {
  const configured = process.env.DATABASE_SSL?.trim().toLowerCase();

  if (configured) {
    switch (configured) {
      case "disable":
        return false;
      case "no-verify":
        return { rejectUnauthorized: false };
      case "require":
        return { rejectUnauthorized: true };
      default:
        throw new Error(
          `DATABASE_SSL must be one of "require", "no-verify", or "disable", but was "${configured}".`,
        );
    }
  }

  return isLocalConnection(url) ? false : { rejectUnauthorized: true };
}

/**
 * Sized for one web service rather than a fleet. Postgres charges real memory
 * per connection and managed plans cap how many exist at once, so a handful of
 * reused connections serves far better than a large pool that exhausts the
 * limit and starts refusing to connect.
 */
function resolvePoolSize(): number {
  const raw = process.env.DATABASE_POOL_MAX;
  if (raw === undefined || raw === "") {
    return 10;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    // Fail at boot rather than quietly running with the default, which would
    // hide a typo in the deployment configuration.
    throw new Error(
      `DATABASE_POOL_MAX must be a positive whole number, but was "${raw}".`,
    );
  }
  return parsed;
}

export const pool = new Pool({
  connectionString,
  ssl: resolveSsl(connectionString),
  max: resolvePoolSize(),
  // Managed providers hang up on connections left sitting; letting them go
  // first avoids handing a half-dead connection to the next request.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * An idle connection dropped by the provider surfaces as an error event on the
 * pool with no query to attach it to. Node treats an unhandled 'error' event as
 * a fatal exception, so without this listener a routine disconnection -- which
 * managed Postgres does on its own schedule -- would take the process down.
 * The pool discards the bad connection and opens another on the next query.
 */
pool.on("error", (error) => {
  logError("Idle database connection error", error);
});

export const db = drizzle(pool, { schema });

/**
 * Releases every pooled connection. Called during shutdown so the database sees
 * connections closed properly instead of waiting for them to time out, which on
 * a plan with a low connection limit can otherwise leave the replacement
 * instance unable to connect while the old ones linger.
 */
export async function closeDatabase(): Promise<void> {
  await pool.end();
}

/**
 * A cheap round trip used by the health check to prove the database is
 * genuinely reachable, not merely configured.
 *
 * The timeout matters: a database that accepts connections but never answers
 * would otherwise leave the health request hanging until the platform's own
 * probe gave up, which reads as "no response" rather than "database down".
 */
export async function pingDatabase(timeoutMs = 3_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Database ping timed out")), timeoutMs);
      }),
    ]);
    return true;
  } catch (error) {
    logError("Database health check failed", error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
