/**
 * The deployment's DATABASE_SSL has the final say over the connection's TLS
 * behaviour. A pasted connection string carrying its own sslmode used to win
 * (pg reads sslmode off the URL and overwrites the ssl option), so
 * `?sslmode=disable` gave an unencrypted connection whatever DATABASE_SSL said.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";

let resolveConnection: typeof import("../db").resolveConnection;

// db.ts builds its pool when imported (no connection is made), so it is loaded
// once with a placeholder URL; resolveConnection reads DATABASE_SSL per call.
beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/app");
  vi.stubEnv("DATABASE_SSL", undefined as unknown as string);
  ({ resolveConnection } = await import("../db"));
  vi.unstubAllEnvs();
}, 60_000);

function resolveFor(url: string, databaseSsl: string | undefined) {
  vi.stubEnv("DATABASE_SSL", databaseSsl as string);
  return resolveConnection(url);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveConnection", () => {
  it("verifies the certificate when DATABASE_SSL=require, whatever the URL's sslmode says", () => {
    const { ssl, connectionString } = resolveFor(
      "postgresql://u:p@db.example.com:5432/app?sslmode=disable",
      "require",
    );
    expect(ssl).toEqual({ rejectUnauthorized: true });
    expect(connectionString).not.toMatch(/sslmode/);
  });

  it("keeps the other query parameters when it drops sslmode", () => {
    const { connectionString } = resolveFor(
      "postgresql://u:p@db.example.com:5432/app?application_name=spo&sslmode=no-verify&connect_timeout=5",
      "require",
    );
    expect(connectionString).toBe(
      "postgresql://u:p@db.example.com:5432/app?application_name=spo&connect_timeout=5",
    );
  });

  it("leaves a URL with no sslmode exactly as given", () => {
    const url = "postgresql://u:p%40x@db.example.com:5432/app";
    const { connectionString } = resolveFor(url, "require");
    expect(connectionString).toBe(url);
  });

  it("honours no-verify and disable the same way", () => {
    const noVerify = resolveFor("postgresql://u:p@db.example.com/app?sslmode=require", "no-verify");
    expect(noVerify.ssl).toEqual({ rejectUnauthorized: false });
    expect(noVerify.connectionString).not.toMatch(/sslmode/);

    const disabled = resolveFor("postgresql://u:p@localhost/app?sslmode=require", "disable");
    expect(disabled.ssl).toBe(false);
    expect(disabled.connectionString).not.toMatch(/sslmode/);
  });

  it("leaves the URL alone when DATABASE_SSL is not set, so the default still verifies a remote host", () => {
    const url = "postgresql://u:p@db.example.com:5432/app?sslmode=require";
    const { ssl, connectionString } = resolveFor(url, undefined);
    expect(ssl).toEqual({ rejectUnauthorized: true });
    expect(connectionString).toBe(url);
  });

  it("still rejects a DATABASE_SSL value it does not know", () => {
    expect(() => resolveFor("postgresql://u:p@db.example.com/app", "verify-full")).toThrow(
      /DATABASE_SSL must be one of/,
    );
  });
});
