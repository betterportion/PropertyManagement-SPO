/**
 * What the server said, for a toast.
 *
 * `apiRequest` throws "<status>: <body>" and the body is the route's JSON, so
 * printing `error.message` shows people `400: {"message":"..."}`. This pulls
 * out what the route wrote for a person to read. A validation refusal
 * (`server/errors.ts`) carries a generic `message` and the real reasons in
 * `errors[].message`, so those win when present. Undefined when there is
 * nothing readable (a network failure, an HTML error page), so the caller's
 * own plain line stands in.
 */
export function serverMessage(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  let body: { message?: unknown; errors?: unknown } | null;
  try {
    body = JSON.parse(error.message.replace(/^\d+:\s*/, ""));
  } catch {
    return undefined;
  }
  const reasons = Array.isArray(body?.errors)
    ? body.errors
        .map((issue: { message?: unknown } | null) => issue?.message)
        .filter((message): message is string => typeof message === "string" && message.length > 0)
    : [];
  if (reasons.length > 0) return Array.from(new Set(reasons)).join(" ");
  return typeof body?.message === "string" && body.message ? body.message : undefined;
}
