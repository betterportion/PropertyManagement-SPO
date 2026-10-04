/**
 * The deployment's DATABASE_SSL has the final say over the connection's TLS
 * behaviour. A pasted connection string carrying its own sslmode used to win
 * (pg reads sslmode off the URL and overwrites the ssl option), so
 * `?sslmode=disable` gave an unencrypted connection whatever DATABASE_SSL said.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

let resolveConnection: typeof import("../db").resolveConnection;

// db.ts builds its pool when imported (no connection is made), so it is loaded
// once with a placeholder URL; resolveConnection reads DATABASE_SSL per call.
beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgresql://u:p@localhost:5432/app");
  vi.stubEnv("DATABASE_SSL", undefined as unknown as string);
  ({ resolveConnection } = await import("../db"));
  vi.unstubAllEnvs();
}, 60_000);

// pg's own parameter handling, the second route: what the driver would really
// connect with for a resolved connection, rather than our reading of the URL.
const ConnectionParameters = createRequire(import.meta.url)("pg/lib/connection-parameters");

function driverSsl(resolved: ReturnType<typeof resolveConnection>) {
  return new ConnectionParameters({ ...resolved }).ssl;
}

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

  // Each of these is read off the URL by pg-connection-string and replaces the
  // ssl option, so each has to go when DATABASE_SSL speaks.
  const TLS_PARAMS = [
    "ssl=0",
    "ssl=false",
    "ssl=no-verify",
    "SSL=0",
    "sslcert=/tmp/client.crt",
    "sslkey=/tmp/client.key",
    "sslrootcert=/tmp/ca.crt",
    "uselibpqcompat=true",
    "sslnegotiation=direct",
  ];

  it.each(TLS_PARAMS)("drops %s so DATABASE_SSL=require still verifies the certificate", (param) => {
    const resolved = resolveFor(`postgresql://u:p@db.example.com:5432/app?${param}`, "require");
    expect(resolved.connectionString).toBe("postgresql://u:p@db.example.com:5432/app");
    expect(driverSsl(resolved)).toEqual({ rejectUnauthorized: true });
  });

  it("is not overridden by ssl=0 when the driver reads the resolved connection", () => {
    const resolved = resolveFor(
      "postgresql://u:p@db.example.com:5432/app?ssl=0&sslmode=disable&uselibpqcompat=true",
      "require",
    );
    expect(driverSsl(resolved)).toEqual({ rejectUnauthorized: true });
  });

  it("drops every TLS parameter at once and keeps the others in order", () => {
    const { connectionString } = resolveFor(
      "postgresql://u:p@db.example.com:5432/app?a=b&sslcert=x&application_name=spo&SSLROOTCERT=y&ssl=0&sslkey=z&uselibpqcompat=true&sslmode=disable&connect_timeout=5&sslnegotiation=direct",
      "require",
    );
    expect(connectionString).toBe(
      "postgresql://u:p@db.example.com:5432/app?a=b&application_name=spo&connect_timeout=5",
    );
  });

  it("leaves a password containing %3F and %26 untouched", () => {
    const { connectionString } = resolveFor(
      "postgresql://u:p%3Fssl%3D0%26x@db.example.com:5432/app?ssl=0&a=b",
      "require",
    );
    expect(connectionString).toBe("postgresql://u:p%3Fssl%3D0%26x@db.example.com:5432/app?a=b");
  });

  it("does not touch a parameter whose name merely contains ssl, or whose value does", () => {
    const url = "postgresql://u:p@db.example.com:5432/app?options=ssl&mysslmode=1&a=ssl=0";
    expect(resolveFor(url, "require").connectionString).toBe(url);
  });

  it("leaves every TLS parameter alone when DATABASE_SSL is not set", () => {
    const url =
      "postgresql://u:p@db.example.com:5432/app?ssl=0&sslcert=x&sslkey=y&sslrootcert=z&uselibpqcompat=true&sslmode=require";
    expect(resolveFor(url, undefined).connectionString).toBe(url);
  });
});
