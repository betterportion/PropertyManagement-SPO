/**
 * Tests for outbound email: the config contract and the send wrapper.
 *
 * The rules being pinned:
 *   - Email is optional. Both variables unset means the feature is off and
 *     the server runs normally — sends report "not configured" instead of
 *     throwing.
 *   - A *partial* configuration is a mistake, and it fails the boot check
 *     loudly rather than silently sending nothing.
 *   - A send failure of any kind returns a result; it never throws into the
 *     request that triggered it. An email is a courtesy, not a transaction.
 *
 * The Resend SDK is mocked: nothing here talks to the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { sendMock, constructedWith } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  constructedWith: { key: undefined as string | undefined },
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
    constructor(key: string) {
      constructedWith.key = key;
    }
  },
}));

import { sendEmail, isEmailConfigured } from "../email";
import { readAppUrlFromEnv, readEmailConfigFromEnv } from "../config";

const VALID_ENV = {
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "SPO Housing <housing@spo.org>",
} as const;

function stubEmailEnv(vars: Partial<Record<"RESEND_API_KEY" | "EMAIL_FROM" | "EMAIL_REPLY_TO", string>>) {
  for (const name of ["RESEND_API_KEY", "EMAIL_FROM", "EMAIL_REPLY_TO"] as const) {
    vi.stubEnv(name, vars[name] as string);
  }
}

beforeEach(() => {
  sendMock.mockReset();
  constructedWith.key = undefined;
  stubEmailEnv({});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Configuration contract
// ---------------------------------------------------------------------------

describe("readEmailConfigFromEnv", () => {
  it("reports email as deliberately off when nothing is set", () => {
    const config = readEmailConfigFromEnv();
    expect(config.configured).toBe(false);
    expect(config.problem).toBeUndefined();
  });

  it("is configured when both the key and the from address are set", () => {
    stubEmailEnv({ ...VALID_ENV, EMAIL_REPLY_TO: "housing-replies@spo.org" });
    const config = readEmailConfigFromEnv();
    expect(config).toEqual({
      configured: true,
      apiKey: "re_test_key",
      from: "SPO Housing <housing@spo.org>",
      replyTo: "housing-replies@spo.org",
    });
  });

  it("treats a key without a from address as a configuration problem", () => {
    stubEmailEnv({ RESEND_API_KEY: "re_test_key" });
    const config = readEmailConfigFromEnv();
    expect(config.configured).toBe(false);
    expect(config.problem).toMatch(/EMAIL_FROM/);
  });

  it("treats a from address without a key as a configuration problem", () => {
    stubEmailEnv({ EMAIL_FROM: "housing@spo.org" });
    const config = readEmailConfigFromEnv();
    expect(config.configured).toBe(false);
    expect(config.problem).toMatch(/RESEND_API_KEY/);
  });

  it("rejects a from value that is not an email address", () => {
    stubEmailEnv({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "SPO Housing" });
    const config = readEmailConfigFromEnv();
    expect(config.configured).toBe(false);
    expect(config.problem).toMatch(/EMAIL_FROM/);
  });
});

describe("readAppUrlFromEnv", () => {
  // The public address is a courtesy for the links in comment email, never a
  // boot requirement: unset means the email goes out without a link.
  it("is simply absent when APP_URL is not set", () => {
    vi.stubEnv("APP_URL", undefined as unknown as string);
    expect(readAppUrlFromEnv()).toEqual({ url: null });
  });

  it("drops a trailing slash so a path can be appended to it", () => {
    vi.stubEnv("APP_URL", "https://housing.spo.org/");
    expect(readAppUrlFromEnv()).toEqual({ url: "https://housing.spo.org" });
  });

  it("keeps an http address, for a development host", () => {
    vi.stubEnv("APP_URL", "http://localhost:5000");
    expect(readAppUrlFromEnv()).toEqual({ url: "http://localhost:5000" });
  });

  it("treats a value that is not a web address as a configuration problem", () => {
    // A link in an email is clicked by everybody it reaches, residents
    // included, so the scheme rule is the one the stored links follow.
    vi.stubEnv("APP_URL", "javascript:alert(1)");
    expect(readAppUrlFromEnv()).toMatchObject({ url: null, problem: expect.stringMatching(/APP_URL/) });
    vi.stubEnv("APP_URL", "housing.spo.org");
    expect(readAppUrlFromEnv()).toMatchObject({ url: null, problem: expect.stringMatching(/APP_URL/) });
  });
});

describe("validateConfiguration wiring", () => {
  // The boot check reads other module-level config, so it is re-imported with
  // a fully valid environment to prove the email problem alone can fail it.
  async function freshValidate() {
    vi.resetModules();
    const { validateConfiguration } = await import("../config");
    return validateConfiguration;
  }

  function stubBaseEnv() {
    vi.stubEnv("DATABASE_URL", "postgresql://user:pass@localhost:5432/db");
    vi.stubEnv("SESSION_SECRET", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("OIDC_ISSUER_URL", "https://accounts.example.com");
    vi.stubEnv("OIDC_CLIENT_ID", "client-id");
    vi.stubEnv("STORAGE_DRIVER", "local");
  }

  it("fails the boot check on a partial email configuration", async () => {
    stubBaseEnv();
    stubEmailEnv({ RESEND_API_KEY: "re_test_key" });
    const validate = await freshValidate();
    expect(() => validate()).toThrow(/EMAIL_FROM/);
  });

  it("boots cleanly with no email configuration at all", async () => {
    stubBaseEnv();
    stubEmailEnv({});
    const validate = await freshValidate();
    expect(() => validate()).not.toThrow();
  });

  it("boots cleanly with a complete email configuration", async () => {
    stubBaseEnv();
    stubEmailEnv(VALID_ENV);
    const validate = await freshValidate();
    expect(() => validate()).not.toThrow();
  });

  it("boots cleanly with no APP_URL, and fails on one that is not a web address", async () => {
    stubBaseEnv();
    vi.stubEnv("APP_URL", undefined as unknown as string);
    const validateUnset = await freshValidate();
    expect(() => validateUnset()).not.toThrow();
    vi.stubEnv("APP_URL", "ftp://housing.spo.org");
    const validate = await freshValidate();
    expect(() => validate()).toThrow(/APP_URL/);
  });
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe("sendEmail", () => {
  const message = {
    to: "ra@example.com",
    subject: "New maintenance request",
    text: "A resident filed a request.",
  };

  it("reports not configured instead of sending when email is off", async () => {
    const result = await sendEmail(message);
    expect(result).toEqual({ sent: false, reason: "not_configured" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(isEmailConfigured()).toBe(false);
  });

  it("sends through Resend with the configured identity", async () => {
    stubEmailEnv({ ...VALID_ENV, EMAIL_REPLY_TO: "housing-replies@spo.org" });
    sendMock.mockResolvedValue({ data: { id: "email-123" }, error: null });

    const result = await sendEmail(message);

    expect(constructedWith.key).toBe("re_test_key");
    expect(sendMock).toHaveBeenCalledWith({
      from: "SPO Housing <housing@spo.org>",
      to: "ra@example.com",
      subject: "New maintenance request",
      text: "A resident filed a request.",
      replyTo: "housing-replies@spo.org",
    });
    expect(result).toEqual({ sent: true, id: "email-123" });
    expect(isEmailConfigured()).toBe(true);
  });

  it("omits replyTo when none is configured", async () => {
    stubEmailEnv(VALID_ENV);
    sendMock.mockResolvedValue({ data: { id: "email-456" }, error: null });

    await sendEmail(message);

    expect(sendMock).toHaveBeenCalledWith({
      from: "SPO Housing <housing@spo.org>",
      to: "ra@example.com",
      subject: "New maintenance request",
      text: "A resident filed a request.",
    });
  });

  it("returns a failure result when Resend reports an error", async () => {
    stubEmailEnv(VALID_ENV);
    sendMock.mockResolvedValue({ data: null, error: { message: "domain not verified" } });

    const result = await sendEmail(message);
    expect(result).toEqual({ sent: false, reason: "send_failed" });
  });

  it("returns a failure result when the SDK throws, rather than throwing", async () => {
    stubEmailEnv(VALID_ENV);
    sendMock.mockRejectedValue(new Error("network down"));

    await expect(sendEmail(message)).resolves.toEqual({ sent: false, reason: "send_failed" });
  });
});
