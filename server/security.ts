import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { RequestHandler } from "express";
import { isProduction } from "./config";

/**
 * Origins the browser is allowed to load uploaded files from.
 *
 * With the Supabase driver a download is a redirect to a signed link on the
 * project's own domain, so that domain has to be named here or images silently
 * fail to render. Left empty for local storage, where everything is same-origin.
 */
function storageOrigins(): string[] {
  const url = process.env.SUPABASE_URL?.trim();
  if (!url) return [];
  try {
    return [new URL(url).origin];
  } catch {
    return [];
  }
}

/**
 * Standard hardening headers.
 *
 * The Content Security Policy is applied in production only. In development
 * Vite injects inline scripts and opens a websocket for hot reload, so any
 * policy strict enough to be worth having would break the dev server -- and a
 * policy relaxed enough for it would not be testing what production runs.
 */
export function securityHeaders(): RequestHandler {
  const storage = storageOrigins();

  return helmet({
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ["'self'"],
            // No 'unsafe-inline': the one inline script the page needs (the
            // theme applied before first paint) is served from /theme-init.js
            // for exactly this reason. Keep it that way.
            scriptSrc: ["'self'"],
            // Inline styles cannot be avoided here -- Radix positions
            // elements by writing style attributes at runtime.
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            // blob: and data: cover the local preview shown while a photo is
            // being chosen, before it has been uploaded anywhere.
            imgSrc: ["'self'", "data:", "blob:", ...storage],
            connectSrc: ["'self'", ...storage],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            // Nobody should be able to frame the portal and trick a signed-in
            // member of staff into clicking something they cannot see.
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: [],
          },
        }
      : false,
    // Six months, matching the usual guidance. Deliberately not preloaded:
    // preloading is effectively irreversible and is the domain owner's
    // decision, not something an application should opt them into.
    hsts: isProduction
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false,
    // Google Fonts is a cross-origin subresource; requiring CORP on it would
    // block the stylesheet.
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });
}

/**
 * Identifies the caller for rate limiting: the signed-in user when there is
 * one, otherwise the client address.
 *
 * **Why:** several members of staff in one office share a public IP, so
 * limiting uploads purely by address would let one person's bulk upload lock
 * out their colleagues.
 */
function userOrIpKey(req: Parameters<RequestHandler>[0]): string {
  const userId = (req as any).user?.claims?.sub;
  // ipKeyGenerator normalises IPv6 to a /64 block, so a client cannot simply
  // move to the next address in its range to get a fresh allowance.
  return userId ? `user:${userId}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

/**
 * Upload limit.
 *
 * Generous enough for the real task -- photographing every room during a
 * walkthrough -- but low enough that a stolen session cannot be used to fill
 * the storage bucket. Sized per person, not per address, see userOrIpKey.
 */
export const uploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  message: { message: "Too many uploads. Please wait a few minutes and try again." },
});

/**
 * Sign-in limit, for `/api/login` and `/api/callback` (one counter for both).
 *
 * Those two routes are open to anybody, and each hit costs something: a
 * `/api/login` stores a seven-day session row, and a request under a new Host
 * header registers a passport strategy that is never released. Keyed by
 * address, since nobody is signed in yet. This is availability protection, not
 * a password lockout; the identity provider does that.
 *
 * **Why 100 per 15 minutes:** one sign-in is two requests (login, then the
 * callback), so this allows 50 sign-ins from one address in 15 minutes. A
 * whole office behind one public IP signing in at the start of a shift stays
 * well under it; a script hammering the route does not. Relies on `trust proxy`
 * so `req.ip` is the visitor, not the reverse proxy.
 */
export const signInRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `ip:${ipKeyGenerator(req.ip ?? "")}`,
  message: { message: "Too many sign-in attempts. Please wait a few minutes and try again." },
});
