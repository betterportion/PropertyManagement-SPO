/**
 * The deployment's DATABASE_SSL has the final say over the connection's TLS
 * behaviour. A pasted connection string carrying its own sslmode used to win
 * (pg reads sslmode off the URL and overwrites the ssl option), so
 * `?sslmode=disable` gave an unencrypted connection whatever DATABASE_SSL said.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

async function resolveFor(url: string, databaseSsl: string | undefined) {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", url);
  vi.stubEnv("DATABASE_SSL", databaseSsl as string);
  const { resolveConnection } = await import("../db");
  return resolveConnection(url);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveConnection", () => {
  it("verifies the certificate when DATABASE_SSL=require, whatever the URL's sslmode says", async () => {
    const { ssl, connectionString } = await resolveFor(
      "postgresql://u:p@db.example.com:5432/app?sslmode=disable",
      "require",
    );
    expect(ssl).toEqual({ rejectUnauthorized: true });
    expect(connectionString).not.toMatch(/sslmode/);
  });

  it("keeps the other query parameters when it drops sslmode", async () => {
    const { connectionString } = await resolveFor(
      "postgresql://u:p@db.example.com:5432/app?application_name=spo&sslmode=no-verify&connect_timeout=5",
      "require",
    );
    expect(connectionString).toBe(
      "postgresql://u:p@db.example.com:5432/app?application_name=spo&connect_timeout=5",
    );
  });

  it("leaves a URL with no sslmode exactly as given", async () => {
    const url = "postgresql://u:p%40x@db.example.com:5432/app";
    const { connectionString } = await resolveFor(url, "require");
    expect(connectionString).toBe(url);
  });

  it("honours no-verify and disable the same way", async () => {
    const noVerify = await resolveFor("postgresql://u:p@db.example.com/app?sslmode=require", "no-verify");
    expect(noVerify.ssl).toEqual({ rejectUnauthorized: false });
    expect(noVerify.connectionString).not.toMatch(/sslmode/);

    const disabled = await resolveFor("postgresql://u:p@localhost/app?sslmode=require", "disable");
    expect(disabled.ssl).toBe(false);
    expect(disabled.connectionString).not.toMatch(/sslmode/);
  });

  it("leaves the URL alone when DATABASE_SSL is not set, so the default still verifies a remote host", async () => {
    const url = "postgresql://u:p@db.example.com:5432/app?sslmode=require";
    const { ssl, connectionString } = await resolveFor(url, undefined);
    expect(ssl).toEqual({ rejectUnauthorized: true });
    expect(connectionString).toBe(url);
  });

  it("still rejects a DATABASE_SSL value it does not know", async () => {
    await expect(resolveFor("postgresql://u:p@db.example.com/app", "verify-full")).rejects.toThrow(
      /DATABASE_SSL must be one of/,
    );
  });
});
