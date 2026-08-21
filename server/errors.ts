import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { ZodError } from "zod";

/**
 * One place that decides what an error means and what the caller is told.
 *
 * Two rules hold everywhere:
 *  1. The full error -- stack included -- is logged on the server.
 *  2. The response contains only a short sentence written for SPO staff.
 *     Stack traces, file paths, SQL, and configuration values never leave the
 *     process, because an error body is one of the easiest ways to leak them.
 */

/** Thrown deliberately by application code to choose a status and a message. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const GENERIC_ERROR_MESSAGE =
  "Something went wrong on our end. Please try again.";

/** A validation failure, reported per field so a form can highlight them. */
interface FieldIssue {
  field: string;
  message: string;
}

export interface ErrorResponse {
  status: number;
  body: { message: string; errors?: FieldIssue[] };
}

/**
 * Zod reports the offending path and a human-readable reason. Both are safe to
 * return: the path is the client's own field name and the reason describes the
 * client's own input. The rest of the issue object is not returned.
 */
function zodIssues(err: ZodError): FieldIssue[] {
  return err.issues.map((issue) => ({
    field: issue.path.join(".") || "(request)",
    message: issue.message,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Postgres surfaces constraint violations as driver errors. Left unmapped they
 * become a 500, which tells the user to retry something that will never
 * succeed. Only the class of failure is reported -- never the driver message,
 * which contains table, column, and constraint names.
 */
function fromDatabaseError(code: string): ErrorResponse | undefined {
  switch (code) {
    case "23505": // unique_violation
      return { status: 409, body: { message: "That record already exists." } };
    case "23503": // foreign_key_violation
      return {
        status: 400,
        body: { message: "That refers to a record that no longer exists." },
      };
    case "23502": // not_null_violation
      return {
        status: 400,
        body: { message: "Some required information is missing." },
      };
    case "22P02": // invalid_text_representation
    case "22003": // numeric_value_out_of_range
      return {
        status: 400,
        body: { message: "Some of the information provided is not valid." },
      };
    default:
      return undefined;
  }
}

/**
 * Maps any thrown value to the status and body the client should receive.
 *
 * `fallbackMessage` is only used for genuinely unexpected failures, so it must
 * be a short, non-technical sentence -- it is shown to the user.
 */
export function classifyError(
  err: unknown,
  fallbackMessage: string = GENERIC_ERROR_MESSAGE,
): ErrorResponse {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        message: "Some of the information provided is not valid.",
        errors: zodIssues(err),
      },
    };
  }

  if (err instanceof HttpError) {
    return { status: err.status, body: { message: err.message } };
  }

  if (isRecord(err)) {
    // body-parser rejects an unreadable request body before any route runs.
    // Its own message is a parser diagnostic ("Expected property name or '}'
    // in JSON at position 2"), which means nothing to a member of staff.
    if (err.type === "entity.parse.failed") {
      return {
        status: 400,
        body: { message: "That request could not be read. Please try again." },
      };
    }
    if (err.type === "entity.too.large") {
      return {
        status: 413,
        body: { message: "That request is too large." },
      };
    }

    // Multer signals oversized or malformed uploads this way. The upload
    // middleware normally catches these first; this is the backstop.
    if (err.name === "MulterError") {
      return {
        status: 400,
        body: { message: "That upload could not be read. Please try again." },
      };
    }

    if (typeof err.code === "string") {
      const mapped = fromDatabaseError(err.code);
      if (mapped) return mapped;
    }

    // Errors from libraries that follow the Express convention of carrying
    // their own status. The status is honoured, but the message never is: a
    // 4xx from a dependency is still a dependency's diagnostic, and those
    // routinely embed file paths, SQL, or configuration values. Only HttpError
    // -- handled above, and written by us -- carries a message to the client.
    const status = err.status ?? err.statusCode;
    if (typeof status === "number" && status >= 400 && status <= 599) {
      return { status, body: { message: fallbackMessage } };
    }
  }

  return { status: 500, body: { message: fallbackMessage } };
}

/** Logs the whole error, with its stack, against a short context label. */
export function logError(context: string, err: unknown): void {
  console.error(`[error] ${context}:`, err);
}

/**
 * Ends a request that failed. Use this in place of an inline
 * `console.error` + `res.status(500)` pair so every route reports the same way.
 *
 * Client mistakes (4xx) are logged as warnings without a stack, so they cannot
 * bury real faults in the log; anything 5xx is logged in full.
 */
export function sendError(
  res: Response,
  err: unknown,
  fallbackMessage: string = GENERIC_ERROR_MESSAGE,
): void {
  const { status, body } = classifyError(err, fallbackMessage);

  if (status >= 500) {
    logError(fallbackMessage, err);
  } else {
    console.warn(`[warn] ${fallbackMessage}: ${status} ${body.message}`);
  }

  // A streamed download may already have started, in which case the status is
  // long gone and writing again would corrupt the response.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(status).json(body);
}

/**
 * Wraps an async handler so a rejected promise becomes an error response.
 *
 * Express 4 does not await a handler's return value, so an async handler that
 * rejects outside its own try/catch never reaches the error middleware and the
 * request simply hangs until the browser times out. Handlers that wrap their
 * whole body in try/catch do not need this; anything else does.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * Answers an unknown `/api` path with JSON. Registered after the real routes
 * but before the single-page-app catch-all, which would otherwise return the
 * app's HTML with a 200 and leave the caller trying to parse it as JSON.
 */
export const apiNotFound: RequestHandler = (_req, res) => {
  res.status(404).json({ message: "That endpoint does not exist." });
};

/**
 * The final Express error middleware.
 *
 * Must be registered after every other layer, including the dev server and
 * static file middleware: Express only reaches an error handler added after
 * the middleware that failed, and its built-in fallback replies with an HTML
 * stack trace in development.
 *
 * It does not re-throw. Re-throwing after responding tells the client nothing
 * it does not already know, and escapes as a process-level fault.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logError(`Unhandled error on ${req.method} ${req.path}`, err);

  const { status, body } = classifyError(err);

  // A response already in flight cannot be given a new status; ending it is
  // all that is left.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(status).json(body);
}
