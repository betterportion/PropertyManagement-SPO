import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";
import passport from "passport";
import session from "express-session";
import type { Express, Request, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { pool } from "./db";
import { storage } from "./storage";

/**
 * ---------------------------------------------------------------------------
 * Identity provider configuration
 * ---------------------------------------------------------------------------
 * This is the ONLY place in the server that knows which login provider is in
 * use. Every default below reproduces Replit Auth exactly, so nothing changes
 * while the app runs on Replit.
 *
 * To move to a different OpenID Connect provider (Auth0, Okta, Google, Keycloak,
 * Authentik, ...), set the OIDC_* environment variables. No code outside this
 * file needs to change.
 *
 * See the "Swapping the identity provider" section of replit.md for the full
 * procedure, including what happens to existing accounts.
 */
const authProvider = {
  /** Discovery root of the provider, e.g. https://your-tenant.auth0.com */
  issuerUrl:
    process.env.OIDC_ISSUER_URL ??
    process.env.ISSUER_URL ??
    "https://replit.com/oidc",

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

const getOidcConfig = memoize(
  async () => {
    if (!authProvider.clientId) {
      throw new Error(
        "No OIDC client ID is configured. Set OIDC_CLIENT_ID, or REPL_ID when running on Replit.",
      );
    }
    return await client.discovery(
      new URL(authProvider.issuerUrl),
      authProvider.clientId,
      authProvider.clientSecret,
    );
  },
  { maxAge: 3600 * 1000 },
);

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000;
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    // Shares the application's connection pool rather than opening a second
    // one. Two pools against a managed database means two sets of connections
    // counting towards the plan's limit, and the SSL and sizing rules in
    // server/db.ts would have to be repeated here to match.
    pool,
    // The sessions table is part of the schema and is created by a migration.
    // Creating it on demand here would race between instances on startup and
    // would leave the schema files no longer describing the real database.
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    // Do not persist a session row for anonymous visitors. The OIDC login flow
    // still works: passport writes state into the session, which marks it
    // dirty and causes it to be saved.
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: 'lax',
      maxAge: sessionTtl,
    },
  });
}

/**
 * Shape of the object passport stores in the session. Route handlers should not
 * read this directly -- use `getUserId(req)` instead, so that swapping provider
 * does not require touching every endpoint.
 */
export interface AuthenticatedUser {
  claims?: {
    sub?: string;
    email?: string;
    exp?: number;
    [claim: string]: unknown;
  };
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
}

/**
 * The single supported way to find out who is signed in.
 *
 * Only valid on routes behind `isAuthenticated`. Throws otherwise, which the
 * surrounding route error handler turns into a 500 -- the same outcome as the
 * previous direct property access, but with a message that explains the cause.
 */
export function getUserId(req: Request): string {
  const user = req.user as AuthenticatedUser | undefined;
  const userId = user?.claims?.sub;
  if (!userId) {
    throw new Error(
      "getUserId() was called on a request with no authenticated user. Put the route behind isAuthenticated.",
    );
  }
  return userId;
}

function updateUserSession(
  user: any,
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  user.refresh_token = tokens.refresh_token;
  user.expires_at = user.claims?.exp;
}

/**
 * Maps provider claims onto our user record.
 *
 * Replit sends first_name / last_name / profile_image_url. Standard OIDC
 * providers send given_name / family_name / picture. Both are accepted so a
 * provider swap does not silently blank out names and avatars.
 *
 * Values stay `undefined` when absent (never null) so that a provider which
 * omits a field does not overwrite data already stored for that user.
 */
async function upsertUser(claims: any) {
  await storage.upsertUser({
    id: claims["sub"],
    email: claims["email"],
    firstName: claims["first_name"] ?? claims["given_name"],
    lastName: claims["last_name"] ?? claims["family_name"],
    profileImageUrl: claims["profile_image_url"] ?? claims["picture"],
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  const config = await getOidcConfig();

  const verify: VerifyFunction = async (
    tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
    verified: passport.AuthenticateCallback
  ) => {
    // Passport waits for `verified` to be called and has no way to observe a
    // rejected promise. Without this catch, a failure while saving the user
    // would leave the login callback hanging until the browser gave up, with
    // no error shown; handing the error to Passport turns it into a failed
    // login instead.
    try {
      const user = {};
      updateUserSession(user, tokens);
      await upsertUser(tokens.claims());
      verified(null, user);
    } catch (error) {
      verified(error instanceof Error ? error : new Error(String(error)));
    }
  };

  const registeredStrategies = new Set<string>();
  const strategyNameFor = (domain: string) => `${authProvider.name}:${domain}`;

  // Local development may serve plain http on a non-default port; every other
  // environment is https behind a proxy. The scheme is deliberately NOT taken
  // from req.protocol -- a request arriving without forwarded-proto headers
  // would otherwise cache an http:// callback URL for a production domain, and
  // the provider would then reject the redirect.
  const originFor = (req: Request) => {
    const domain = req.hostname;
    return /^(localhost|127\.0\.0\.1|::1)$/.test(domain)
      ? `http://${req.get("host") ?? domain}`
      : `https://${domain}`;
  };

  const ensureStrategy = (req: Request) => {
    const strategyName = strategyNameFor(req.hostname);
    if (!registeredStrategies.has(strategyName)) {
      const strategy = new Strategy(
        {
          name: strategyName,
          config,
          scope: authProvider.scopes.join(" "),
          callbackURL: `${originFor(req)}/api/callback`,
        },
        verify,
      );
      passport.use(strategy);
      registeredStrategies.add(strategyName);
    }
  };

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  app.get("/api/login", (req, res, next) => {
    ensureStrategy(req);
    passport.authenticate(strategyNameFor(req.hostname), {
      prompt: "login consent",
      scope: authProvider.scopes,
    })(req, res, next);
  });

  app.get("/api/callback", (req, res, next) => {
    ensureStrategy(req);
    passport.authenticate(strategyNameFor(req.hostname), {
      successReturnToOrRedirect: "/",
      failureRedirect: "/api/login",
    })(req, res, next);
  });

  app.get("/api/logout", (req, res) => {
    const homeUrl = originFor(req);
    req.logout(() => {
      // Not every OIDC provider advertises an end-session endpoint. When one is
      // missing, clearing our own session and returning home is the correct
      // fallback rather than a crash.
      try {
        res.redirect(
          client.buildEndSessionUrl(config, {
            client_id: authProvider.clientId!,
            post_logout_redirect_uri: homeUrl,
          }).href
        );
      } catch {
        res.redirect(homeUrl);
      }
    });
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  const user = req.user as any;

  // claims.sub is required as well as expires_at, so that a malformed or
  // legacy session cannot reach a route handler and turn getUserId() into a 500.
  if (!req.isAuthenticated() || !user.expires_at || !user.claims?.sub) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) {
    return next();
  }

  const refreshToken = user.refresh_token;
  if (!refreshToken) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, refreshToken);
    updateUserSession(user, tokenResponse);
    return next();
  } catch (error) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
};
