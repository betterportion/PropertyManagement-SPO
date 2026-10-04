/**
 * `/api/login` and `/api/callback` are unauthenticated, and each `/api/login`
 * stores a session row and each new Host header registers a passport strategy,
 * so both are rate limited by client address (#275). This runs the real
 * `setupAuth` over real HTTP; only the database, the session store and the
 * provider's discovery document are replaced.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import express from "express";
import type { Server } from "node:http";

// Each test makes 100+ real requests, which is slow when other suites run
// alongside.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../storage", () => ({ storage: {} }));

// A provider description with no network behind it: enough for /api/login to
// build its redirect to the provider.
vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: vi.fn(
      async () =>
        new actual.Configuration(
          {
            issuer: "https://idp.test",
            authorization_endpoint: "https://idp.test/authorize",
            token_endpoint: "https://idp.test/token",
          },
          "client-id",
        ),
    ),
  };
});

vi.mock("connect-pg-simple", async () => {
  const { default: session } = await import("express-session");
  return { default: () => session.MemoryStore };
});

vi.stubEnv("SESSION_SECRET", "test-secret");
vi.stubEnv("OIDC_ISSUER_URL", "https://idp.test");
vi.stubEnv("OIDC_CLIENT_ID", "client-id");

afterAll(() => {
  vi.unstubAllEnvs();
});

const LIMIT = 100;

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

async function startPortal(): Promise<string> {
  const { setupAuth } = await import("../auth");
  const app = express();
  await setupAuth(app);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no port");
  return `http://127.0.0.1:${address.port}`;
}

/** One request as it would arrive through the reverse proxy from `ip`. */
const hit = (base: string, path: string, ip: string) =>
  fetch(`${base}${path}`, { redirect: "manual", headers: { "X-Forwarded-For": ip } });

describe("sign-in routes are rate limited by client address", () => {
  it("lets /api/login through until the limit, then answers 429 with a Retry-After", async () => {
    const base = await startPortal();

    // Positive control: the route works, and is not already a 429.
    const first = await hit(base, "/api/login", "198.51.100.1");
    expect(first.status).toBe(302);
    expect(first.headers.get("location")).toContain("https://idp.test/authorize");

    for (let i = 1; i < LIMIT; i++) {
      expect((await hit(base, "/api/login", "198.51.100.1")).status).not.toBe(429);
    }
    const refused = await hit(base, "/api/login", "198.51.100.1");

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    expect(await refused.json()).toEqual({ message: "Too many sign-in attempts. Please wait a few minutes and try again." });
  });

  it("counts /api/login and /api/callback together, so neither is a way round the other", async () => {
    const base = await startPortal();

    for (let i = 0; i < LIMIT; i++) {
      expect((await hit(base, i % 2 ? "/api/callback" : "/api/login", "198.51.100.2")).status).not.toBe(429);
    }

    expect((await hit(base, "/api/callback", "198.51.100.2")).status).toBe(429);
    expect((await hit(base, "/api/login", "198.51.100.2")).status).toBe(429);
  });

  it("keys on the real client address behind the proxy: another address is unaffected", async () => {
    const base = await startPortal();

    for (let i = 0; i < LIMIT; i++) await hit(base, "/api/login", "198.51.100.3");
    expect((await hit(base, "/api/login", "198.51.100.3")).status).toBe(429);

    // If the key were the proxy's own address, this would be refused too.
    expect((await hit(base, "/api/login", "198.51.100.4")).status).toBe(302);
  });

  it("does not limit anything else", async () => {
    const base = await startPortal();

    for (let i = 0; i < LIMIT; i++) await hit(base, "/api/login", "198.51.100.5");
    expect((await hit(base, "/api/login", "198.51.100.5")).status).toBe(429);

    // /api/logout is not a sign-in route; it answers (a redirect), never 429.
    expect((await hit(base, "/api/logout", "198.51.100.5")).status).not.toBe(429);
  });
});
