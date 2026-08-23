/**
 * Route-level tests for the JotForm webhook.
 *
 * The regression that motivates this file: JotForm delivers submissions as
 * multipart/form-data, and the route once had no multipart parser — every
 * real submission returned 200 while silently creating a request with every
 * field defaulted. These tests drive the real route with both encodings and
 * assert on what was actually stored, not just the status code.
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import express from "express";
import type { Server } from "node:http";

const { createRequestMock } = vi.hoisted(() => ({
  createRequestMock: vi.fn(),
}));

vi.mock("../db", () => ({ db: {}, pool: {} }));

vi.mock("../auth", () => ({
  setupAuth: vi.fn().mockResolvedValue(undefined),
  isAuthenticated: (_req: any, res: any) =>
    res.status(401).json({ message: "Unauthorized" }),
  getUserId: () => {
    throw new Error("no user in webhook tests");
  },
}));

vi.mock("../storage", () => ({
  storage: {
    createMaintenanceRequest: createRequestMock,
  },
}));

vi.mock("../objectStorage", () => ({
  generateStorageKey: vi.fn(),
  isSafeStorageKey: vi.fn(() => true),
  putUpload: vi.fn(),
  uploadExists: vi.fn(),
  removeUpload: vi.fn(),
  openUploadStream: vi.fn(),
  createUploadSignedUrl: vi.fn(),
  contentTypeFor: vi.fn(),
}));

import { registerRoutes } from "../routes";
import { errorHandler } from "../errors";

let server: Server;
let baseUrl: string;
const savedSecret = process.env.JOTFORM_WEBHOOK_SECRET;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  server = await registerRoutes(app);
  // Same position as in index.ts, so a parser failure on the webhook route
  // becomes the clean 400 production sends rather than Express's HTML page.
  app.use(errorHandler);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) => {
      if (savedSecret === undefined) delete process.env.JOTFORM_WEBHOOK_SECRET;
      else process.env.JOTFORM_WEBHOOK_SECRET = savedSecret;
      server.close((err) => (err ? reject(err) : resolve()));
    })
);

beforeEach(() => {
  createRequestMock.mockReset();
  createRequestMock.mockResolvedValue({ id: "req-1" });
  process.env.JOTFORM_WEBHOOK_SECRET = "test-webhook-secret";
});

const webhookUrl = (secret?: string) =>
  `${baseUrl}/api/webhooks/jotform${secret ? `?secret=${secret}` : ""}`;

/** The shape JotForm actually posts: multipart with a rawRequest JSON field. */
function jotformSubmission(fields: Record<string, string>): FormData {
  const form = new FormData();
  form.append("rawRequest", JSON.stringify(fields));
  form.append("formTitle", "Maintenance Form");
  return form;
}

describe("POST /api/webhooks/jotform", () => {
  it("returns 503 and stores nothing when no secret is configured", async () => {
    delete process.env.JOTFORM_WEBHOOK_SECRET;
    const res = await fetch(webhookUrl("anything"), {
      method: "POST",
      body: jotformSubmission({ q3_title: "should not land" }),
    });
    expect(res.status).toBe(503);
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it("returns 401 and stores nothing for a wrong secret", async () => {
    const res = await fetch(webhookUrl("wrong-secret"), {
      method: "POST",
      body: jotformSubmission({ q3_title: "should not land" }),
    });
    expect(res.status).toBe(401);
    expect(createRequestMock).not.toHaveBeenCalled();
  });

  it("parses a multipart submission and maps its fields (positive control)", async () => {
    const res = await fetch(webhookUrl("test-webhook-secret"), {
      method: "POST",
      body: jotformSubmission({
        q3_title: "Leaking kitchen faucet",
        q4_description: "Drips constantly under the sink",
        q5_priority: "High",
        q6_email: "resident@spo.org",
        q7_region: "West Central",
      }),
    });
    expect(res.status).toBe(200);
    expect(createRequestMock).toHaveBeenCalledTimes(1);
    expect(createRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Leaking kitchen faucet",
        description: "Drips constantly under the sink",
        priority: "high",
        region: "West Central",
        submittedBy: "resident@spo.org",
        status: "pending",
      })
    );
  });

  it("still accepts a urlencoded submission", async () => {
    const raw = encodeURIComponent(
      JSON.stringify({ q3_title: "Broken latch", q7_region: "North East" })
    );
    const res = await fetch(webhookUrl("test-webhook-secret"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `rawRequest=${raw}`,
    });
    expect(res.status).toBe(200);
    expect(createRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Broken latch", region: "North East" })
    );
  });

  it("refuses a multipart request carrying an actual file part", async () => {
    const form = jotformSubmission({ q3_title: "smuggled" });
    form.append("attachment", new Blob([Buffer.alloc(64)]), "x.bin");
    const res = await fetch(webhookUrl("test-webhook-secret"), {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    expect(createRequestMock).not.toHaveBeenCalled();
  });
});
