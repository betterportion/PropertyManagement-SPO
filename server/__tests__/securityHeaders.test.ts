/**
 * The production security settings, asserted over real HTTP where they are
 * HTTP behaviour: the Content Security Policy and HSTS, the session cookie's
 * flags, `trust proxy`, and the upload rate limit's 429. The boot check that
 * refuses a short SESSION_SECRET is asserted directly.
 *
 * Every one of these was mutation-tested in the 2026-09-29 audit by removing
 * it and watching the suite stay green; each test below is paired with a
 * positive control so a typo cannot make the negative vacuous.
 *
 * `isProduction` is read once, when `server/config.ts` loads, so NODE_ENV is
 * stubbed to "production" first and every module under test is imported fresh
 * afterwards (`vi.resetModules`). The stub is undone in `afterAll`.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express, { type Express } from "express";
import type { Server } from "node:http";

// Each test imports the server modules fresh, which is slow when other suites
// are running alongside.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../storage", () => ({ storage: {} }));

// Sign-in discovery would otherwise reach out to the identity provider when
// setupAuth runs. Nothing here signs anybody in.
vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return { ...actual, discovery: vi.fn(async () => ({})) };
});

// The session cookie's flags are express-session's own output, whatever store
// sits behind it; a memory store stands in for the Postgres one so no pool is
// needed. `getSession()` itself, where the flags are chosen, is the real one.
vi.mock("connect-pg-simple", async () => {
  const { default: session } = await import("express-session");
  return { default: () => session.MemoryStore };
});

const VALID_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  OIDC_ISSUER_URL: "https://accounts.google.com",
  OIDC_CLIENT_ID: "client-id",
  STORAGE_DRIVER: "local",
  SESSION_SECRET: "s".repeat(32),
};

beforeAll(() => {
  for (const [name, value] of Object.entries(VALID_ENV)) vi.stubEnv(name, value);
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

beforeEach(() => {
  vi.resetModules();
});

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function serve(app: Express): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no port");
  return `http://127.0.0.1:${address.port}`;
}

describe("Content Security Policy and HSTS", () => {
  async function headersFromProductionApp(): Promise<Headers> {
    const { securityHeaders } = await import("../security");
    const app = express();
    app.use(securityHeaders());
    app.get("/", (_req, res) => res.send("ok"));
    const res = await fetch(`${await serve(app)}/`);
    return res.headers;
  }

  it("forbids framing and inline or foreign scripts", async () => {
    const csp = (await headersFromProductionApp()).get("content-security-policy") ?? "";

    expect(csp).toContain("frame-ancestors 'none'");
    // Exactly 'self': no 'unsafe-inline', no 'unsafe-eval', no other origin.
    expect(csp).toMatch(/(^|;)script-src 'self'(;|$)/);
    expect(csp).toContain("object-src 'none'");
  });

  it("sends Strict-Transport-Security for six months, subdomains included", async () => {
    const hsts = (await headersFromProductionApp()).get("strict-transport-security");

    expect(hsts).toContain("max-age=15552000");
    expect(hsts).toContain("includeSubDomains");
  });

  it("sends neither outside production (positive control: the test sees the difference)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    try {
      vi.resetModules();
      const headers = await headersFromProductionApp();

      expect(headers.get("content-security-policy")).toBeNull();
      expect(headers.get("strict-transport-security")).toBeNull();
      // Helmet's other defaults are still on, so the middleware did run.
      expect(headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      vi.stubEnv("NODE_ENV", "production");
    }
  });
});

describe("session cookie and trust proxy, through the real setupAuth", () => {
  async function authedApp(): Promise<string> {
    const { setupAuth } = await import("../auth");
    const app = express();
    await setupAuth(app);
    app.get("/probe", (req, res) => {
      // Marks the session dirty so express-session issues its cookie.
      (req.session as unknown as Record<string, unknown>).probe = true;
      res.json({ ip: req.ip, protocol: req.protocol });
    });
    return serve(app);
  }

  it("is HttpOnly, Secure and SameSite=Lax when the proxy says the visitor is on https", async () => {
    const base = await authedApp();

    const res = await fetch(`${base}/probe`, { headers: { "X-Forwarded-Proto": "https" } });
    const cookie = res.headers.get("set-cookie") ?? "";

    expect(cookie).toMatch(/^connect\.sid=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("is never sent over plain http in production (the Secure flag is enforced, not decorative)", async () => {
    const base = await authedApp();

    const res = await fetch(`${base}/probe`);

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("trusts exactly one proxy hop: the client address and scheme come from the forwarded headers", async () => {
    const base = await authedApp();

    const res = await fetch(`${base}/probe`, {
      headers: { "X-Forwarded-For": "198.51.100.7", "X-Forwarded-Proto": "https" },
    });

    expect(await res.json()).toEqual({ ip: "198.51.100.7", protocol: "https" });
  });

  it("does not let a client forge a further hop", async () => {
    const base = await authedApp();

    // A client prepending its own address: with `trust proxy` 1 only the
    // right-most entry (what the one real proxy appended) counts.
    const res = await fetch(`${base}/probe`, {
      headers: { "X-Forwarded-For": "203.0.113.99, 198.51.100.7" },
    });

    expect((await res.json()).ip).toBe("198.51.100.7");
  });
});

describe("SESSION_SECRET length in production", () => {
  async function bootCheck(secret: string): Promise<string | null> {
    vi.stubEnv("SESSION_SECRET", secret);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { validateConfiguration } = await import("../config");
      validateConfiguration();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      warn.mockRestore();
      vi.stubEnv("SESSION_SECRET", VALID_ENV.SESSION_SECRET);
    }
  }

  it("accepts 32 characters (positive control: the rest of the configuration is valid)", async () => {
    expect(await bootCheck("a".repeat(32))).toBeNull();
  });

  it("refuses 31 characters and says which variable and how long it was", async () => {
    const problem = await bootCheck("a".repeat(31));

    expect(problem).toContain("SESSION_SECRET is only 31 characters");
  });
});

describe("upload rate limit", () => {
  it("answers 429 on the request past the limit, and not before", async () => {
    const { uploadRateLimit } = await import("../security");
    const app = express();
    app.post("/upload", uploadRateLimit, (_req, res) => res.json({ ok: true }));
    const base = await serve(app);

    // 120 per 15 minutes per person (here: per address, nobody is signed in).
    for (let i = 0; i < 120; i++) {
      const res = await fetch(`${base}/upload`, { method: "POST" });
      expect(res.status).toBe(200);
    }
    const refused = await fetch(`${base}/upload`, { method: "POST" });

    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ message: "Too many uploads. Please wait a few minutes and try again." });
  });
});
