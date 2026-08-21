import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { z } from "zod";
import {
  HttpError,
  apiNotFound,
  asyncHandler,
  classifyError,
  errorHandler,
} from "../errors";

/**
 * These cover the two promises the error handling makes:
 *  1. a failing request gets a sensible status and a message safe to show;
 *  2. a failing request always gets *an* answer -- it never hangs, and it
 *     never takes the process down.
 */

// The classifier logs nothing, but the middleware does; keep the test output
// readable without hiding a genuine failure.
beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("classifyError", () => {
  it("turns a validation failure into a 400 listing the offending fields", () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const parsed = schema.safeParse({ age: "not a number" });
    expect(parsed.success).toBe(false);

    const { status, body } = classifyError((parsed as any).error);

    expect(status).toBe(400);
    expect(body.message).toBe("Some of the information provided is not valid.");
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "name" }),
        expect.objectContaining({ field: "age" }),
      ]),
    );
  });

  it("uses the status and message of an error the application raised itself", () => {
    const { status, body } = classifyError(
      new HttpError(403, "You do not have access to that region."),
    );

    expect(status).toBe(403);
    expect(body.message).toBe("You do not have access to that region.");
  });

  it("keeps a dependency's status but never its message", () => {
    // A 4xx status is no evidence the text is safe: library errors routinely
    // name files, tables, and configuration values.
    const leaky: any = new Error(
      "ENOENT /home/runner/workspace/server/secrets.json",
    );
    leaky.status = 400;

    const { status, body } = classifyError(leaky, "Failed to save the record");

    expect(status).toBe(400);
    expect(body.message).toBe("Failed to save the record");
    expect(JSON.stringify(body)).not.toContain("/home/runner");
  });

  it("replaces the parser's diagnostic for an unreadable request body", () => {
    const parseFailure: any = new SyntaxError(
      "Expected property name or '}' in JSON at position 2",
    );
    parseFailure.type = "entity.parse.failed";
    parseFailure.status = 400;

    const { status, body } = classifyError(parseFailure);

    expect(status).toBe(400);
    expect(body.message).toBe("That request could not be read. Please try again.");
  });

  it("reports an oversized body as 413", () => {
    const tooLarge: any = new Error("request entity too large");
    tooLarge.type = "entity.too.large";

    expect(classifyError(tooLarge).status).toBe(413);
  });

  it("maps database constraint violations to something actionable", () => {
    const duplicate: any = new Error("duplicate key value violates unique constraint");
    duplicate.code = "23505";
    const orphan: any = new Error("insert or update violates foreign key constraint");
    orphan.code = "23503";

    expect(classifyError(duplicate).status).toBe(409);
    expect(classifyError(orphan).status).toBe(400);

    // The driver message names the constraint; it must not be forwarded.
    expect(classifyError(duplicate).body.message).not.toContain("constraint");
  });

  it("treats an unrecognised failure as a 500 with the supplied wording", () => {
    const { status, body } = classifyError(
      new Error("connect ECONNREFUSED 10.0.0.1:5432"),
      "Failed to load properties",
    );

    expect(status).toBe(500);
    expect(body.message).toBe("Failed to load properties");
    expect(body.errors).toBeUndefined();
  });

  it("never returns a stack trace", () => {
    const withStack = new Error("boom");
    const serialised = JSON.stringify(classifyError(withStack).body);

    expect(serialised).not.toContain("at ");
    expect(serialised).not.toContain(".ts:");
  });
});

describe("the error middleware, over real HTTP", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());

    app.get("/api/ok", (_req, res) => {
      res.json({ ok: true });
    });

    // The case Express 4 cannot handle on its own: an async handler that
    // rejects. Without asyncHandler the request would never be answered.
    app.get(
      "/api/async-boom",
      asyncHandler(async () => {
        throw new Error("failure inside an async handler");
      }),
    );

    app.get("/api/sync-boom", () => {
      throw new HttpError(418, "Deliberate failure.");
    });

    app.use("/api", apiNotFound);
    app.use(errorHandler);

    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("answers an async handler that rejects instead of leaving it hanging", async () => {
    const res = await fetch(`${baseUrl}/api/async-boom`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      message: "Something went wrong on our end. Please try again.",
    });
  });

  it("answers a handler that throws, using the status it asked for", async () => {
    const res = await fetch(`${baseUrl}/api/sync-boom`);

    expect(res.status).toBe(418);
    expect((await res.json()).message).toBe("Deliberate failure.");
  });

  it("rejects an unreadable JSON body without exposing the parser's wording", async () => {
    const res = await fetch(`${baseUrl}/api/ok`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe("That request could not be read. Please try again.");
    expect(JSON.stringify(body)).not.toContain("position");
  });

  it("answers an unknown /api path with JSON rather than falling through", async () => {
    const res = await fetch(`${baseUrl}/api/no-such-endpoint`);

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).message).toBe("That endpoint does not exist.");
  });

  it("keeps serving after a failure -- one bad request is not an outage", async () => {
    await fetch(`${baseUrl}/api/async-boom`);
    await fetch(`${baseUrl}/api/sync-boom`);

    const res = await fetch(`${baseUrl}/api/ok`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
