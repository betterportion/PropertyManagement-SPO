import { resolveStorageDriverName } from "./objectStorage";
import { readSupabaseConfigFromEnv } from "./objectStorage/supabase";

export const isProduction = process.env.NODE_ENV === "production";

/**
 * True when the process is running inside a Replit workspace or deployment.
 *
 * Used only to decide whether Replit's own defaults may be assumed. Everywhere
 * else the application is an ordinary Node service and must not depend on this.
 */
export const onReplit = process.env.REPL_ID !== undefined;

/**
 * ---------------------------------------------------------------------------
 * Identity provider configuration
 * ---------------------------------------------------------------------------
 * The only place that knows which login provider is in use. Every default
 * reproduces Replit Auth, so nothing changes while the app runs on Replit; set
 * the OIDC_* variables to point at any other OpenID Connect provider (Auth0,
 * Okta, Google, Keycloak, Authentik, ...) without touching code.
 */
export const authProvider = {
  /** Discovery root of the provider, e.g. https://your-tenant.auth0.com */
  issuerUrl:
    process.env.OIDC_ISSUER_URL ??
    process.env.ISSUER_URL ??
    (onReplit ? "https://replit.com/oidc" : undefined),

  /** On Replit this is REPL_ID; elsewhere it is the client ID your provider issues. */
  clientId: process.env.OIDC_CLIENT_ID ?? process.env.REPL_ID,

  /** Replit uses a public client (PKCE, no secret). Most other providers issue one. */
  clientSecret: process.env.OIDC_CLIENT_SECRET,

  /** Internal passport strategy prefix only; never shown to users. */
  name: process.env.OIDC_PROVIDER_NAME ?? "replitauth",

  /** offline_access is what allows sessions to refresh without re-prompting. */
  scopes: (process.env.OIDC_SCOPES ?? "openid email profile offline_access")
    .split(/\s+/)
    .filter(Boolean),
};

function checkDatabase(problems: string[]): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    problems.push(
      "DATABASE_URL is not set. It must be a PostgreSQL connection string, for example\n" +
        "    postgresql://user:password@host:5432/database",
    );
    return;
  }

  // A value that is not a URL at all fails much later, inside the driver, with
  // a message that does not mention the variable that caused it.
  try {
    const { protocol } = new URL(url);
    if (protocol !== "postgres:" && protocol !== "postgresql:") {
      problems.push(
        `DATABASE_URL must start with postgresql:// but starts with ${protocol}//`,
      );
    }
  } catch {
    problems.push("DATABASE_URL is not a valid connection string.");
  }
}

function checkSessionSecret(problems: string[]): void {
  const secret = process.env.SESSION_SECRET;

  if (!secret) {
    problems.push(
      "SESSION_SECRET is not set. Generate one with:\n" +
        "    node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
    return;
  }

  // Sessions are the only thing standing between a visitor and every staff
  // account, and a guessable signing key makes them forgeable. Enforced in
  // production only, so a throwaway value keeps working while developing.
  if (isProduction && secret.length < 32) {
    problems.push(
      `SESSION_SECRET is only ${secret.length} characters. Use at least 32 random ` +
        "characters in production, or signed session cookies can be forged.",
    );
  }
}

function checkAuth(problems: string[]): void {
  // Off Replit there is no REPL_ID to fall back to, so both values must be
  // given. Saying so at boot turns a puzzling "invalid redirect_uri" from the
  // provider, hours later, into a startup message naming the variable to set.
  const offReplitHint = onReplit
    ? ""
    : "\n    Replit Auth cannot be used from another host: it only accepts logins from a" +
      "\n    replit.dev or replit.app address, so this host needs its own provider.";

  if (!authProvider.clientId) {
    problems.push(
      "OIDC_CLIENT_ID is not set. It is the client ID your identity provider issued for" +
        "\n    this application." +
        offReplitHint,
    );
  }

  if (!authProvider.issuerUrl) {
    problems.push(
      "OIDC_ISSUER_URL is not set. It is the address of your login provider, for example" +
        "\n    https://your-tenant.auth0.com -- the application discovers everything else from it.",
    );
    return;
  }

  try {
    new URL(authProvider.issuerUrl);
  } catch {
    problems.push(`OIDC_ISSUER_URL is not a valid URL: "${authProvider.issuerUrl}"`);
    return;
  }

  // A client ID from somewhere else pointed at Replit's issuer is a
  // configuration that can only fail, and it fails at the login screen rather
  // than at boot, so it is worth catching here.
  const issuerWasChosen =
    process.env.OIDC_ISSUER_URL !== undefined || process.env.ISSUER_URL !== undefined;

  if (process.env.OIDC_CLIENT_ID && !issuerWasChosen) {
    problems.push(
      "OIDC_CLIENT_ID is set but OIDC_ISSUER_URL is not, so login would be attempted" +
        "\n    against Replit's provider using another provider's client ID. Set OIDC_ISSUER_URL.",
    );
  }
}

function checkStorage(problems: string[]): void {
  let driver: string;
  try {
    driver = resolveStorageDriverName();
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
    return;
  }

  if (driver === "supabase") {
    try {
      readSupabaseConfigFromEnv();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Not fatal: a single always-on server with a mounted disk is a legitimate
  // place to keep files. It is only a mistake on a platform that rebuilds the
  // filesystem on deploy, which is most of them, so it is worth saying out loud.
  if (driver === "local" && isProduction) {
    console.warn(
      "[config] STORAGE_DRIVER=local in production. Uploaded files are written to this " +
        "server's filesystem and will be lost if the host replaces it on deploy.",
    );
  }
}

/**
 * Checks everything the server cannot run without, and reports all of it at
 * once.
 *
 * **Why:** these values used to fail at the moment they were first used --
 * a missing session secret during the first login, a missing storage
 * credential during the first upload -- so a deployment could look healthy for
 * hours and then break for one person doing one thing. Failing at boot means
 * the platform sees the deploy fail and keeps the previous version serving.
 *
 * **How to apply:** call this before importing anything that reads
 * configuration at module level, so the collected report is what the operator
 * sees rather than whichever module happened to load first.
 */
export function validateConfiguration(): void {
  const problems: string[] = [];

  checkDatabase(problems);
  checkSessionSecret(problems);
  checkAuth(problems);
  checkStorage(problems);

  if (problems.length === 0) return;

  const heading =
    problems.length === 1
      ? "The server cannot start because of a configuration problem:"
      : `The server cannot start because of ${problems.length} configuration problems:`;

  throw new Error(
    `${heading}\n\n` +
      problems.map((problem, i) => `  ${i + 1}. ${problem}`).join("\n\n") +
      "\n\nSee .env.example for what each variable is for.",
  );
}
