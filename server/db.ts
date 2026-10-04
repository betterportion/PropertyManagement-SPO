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
 * Setting this explicitly also overrides every TLS parameter in the connection
 * string (`ssl`, `sslmode`, `sslcert`, `sslkey`, `sslrootcert`, `uselibpqcompat`
 * and `sslnegotiation`), so the deployment configuration has the final say. `pg`
 * itself would let the URL win, so `resolveConnection` removes them before the
 * pool sees it.
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
 * The query parameters pg-connection-string (pg 8.23 / 2.14) reads off a URL and
 * lets replace the `ssl` option: `ssl` itself (`ssl=0` is plaintext), `sslmode`,
 * the three certificate paths (any one swaps `ssl` for an object built from
 * them), `uselibpqcompat` (loosens what `sslmode` verifies) and `sslnegotiation`
 * (`direct` turns `ssl` on as plain `true`). Lowercase; names are compared
 * case-insensitively.
 */
const TLS_QUERY_PARAMS = new Set([
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "uselibpqcompat",
  "sslnegotiation",
]);

/**
 * Removes the TLS parameters above from the connection string's query. `pg`
 * applies them over the `ssl` option, so a pasted `?ssl=0` or `?sslmode=disable`
 * would give an unencrypted or unverified connection whatever DATABASE_SSL says.
 * Only the query is rewritten, so credentials in the rest of the string are
 * untouched; other parameters keep their order.
 */
function withoutTlsParams(url: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;

  const kept = url
    .slice(queryStart + 1)
    .split("&")
    .filter((param) => !TLS_QUERY_PARAMS.has(param.split("=")[0].toLowerCase()));
  const base = url.slice(0, queryStart);
  return kept.length > 0 ? `${base}?${kept.join("&")}` : base;
}

/**
 * The connection string and TLS option the pool is built from. When
 * DATABASE_SSL is set it is the only word on TLS; when it is not, the URL is
 * left as given and the default above applies.
 */
export function resolveConnection(url: string): {
  connectionString: string;
  ssl: pg.PoolConfig["ssl"];
} {
  const ssl = resolveSsl(url);
  const overridden = Boolean(process.env.DATABASE_SSL?.trim());
  return { connectionString: overridden ? withoutTlsParams(url) : url, ssl };
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
  ...resolveConnection(connectionString),
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
