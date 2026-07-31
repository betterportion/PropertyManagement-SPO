import multer from "multer";
import type { RequestHandler } from "express";

/**
 * Uploads are held in memory while they are written to App Storage, so the
 * amount of upload data being processed at any one moment is the amount of
 * memory the process is holding for uploads.
 *
 * Per-file limits alone do not bound that: they cap one request, not how many
 * requests run at once. Enough simultaneous large uploads could exhaust an
 * instance and take the app down for everyone on it. These helpers put a ceiling
 * on the total, and turn a rejected upload into a clear answer rather than an
 * error that escapes into the global handler.
 */

export const IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Room for the multipart envelope around the file itself: the boundary lines and
 * part headers. The upload routes accept a single part and no text fields, so
 * nothing else can be buffered on top of the file, and this reservation really
 * is the most a request can cost.
 */
const REQUEST_OVERHEAD_BYTES = 1024 * 1024;

const DEFAULT_MAX_IN_FLIGHT_BYTES = 64 * 1024 * 1024;

function readConfiguredCeiling(): number {
  const raw = process.env.MAX_UPLOAD_BYTES_IN_FLIGHT;
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX_IN_FLIGHT_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // Fail loudly at boot rather than silently running with the default, which
    // would hide a typo in the deployment configuration.
    throw new Error(
      `MAX_UPLOAD_BYTES_IN_FLIGHT must be a positive number of bytes, but was "${raw}".`,
    );
  }
  return parsed;
}

const maxInFlightBytes = readConfiguredCeiling();

let inFlightBytes = 0;

/** Exposed for tests and diagnostics. */
export function currentInFlightUploadBytes(): number {
  return inFlightBytes;
}

export function maxInFlightUploadBytes(): number {
  return maxInFlightBytes;
}

function describeSize(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * Reserves capacity for a request before its body is read, and releases it once
 * the response is done. Requests that would push the total over the ceiling are
 * turned away immediately, before any of their body is buffered.
 */
function reserveUploadCapacity(maxRequestBytes: number): RequestHandler {
  return (req, res, next) => {
    const declared = Number(req.headers["content-length"]);
    // A chunked request declares no length, so it is charged the most it could
    // legitimately be. Anything larger is rejected by the per-file limit anyway.
    const reserved =
      Number.isFinite(declared) && declared > 0
        ? Math.min(declared, maxRequestBytes)
        : maxRequestBytes;

    if (inFlightBytes + reserved > maxInFlightBytes) {
      res.setHeader("Retry-After", "5");
      return res.status(503).json({
        message:
          "The server is handling too many uploads at the moment. Please try again in a few seconds.",
      });
    }

    inFlightBytes += reserved;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlightBytes -= reserved;
    };
    // "close" covers clients that disconnect part way through, which "finish"
    // does not. Both can fire, hence the guard.
    res.on("finish", release);
    res.on("close", release);

    next();
  };
}

/**
 * Answers multer's own rejections here instead of letting them reach the global
 * error handler, which re-throws after responding and would bring the process
 * down on something as ordinary as an oversized file.
 */
function withUploadErrorHandling(
  uploadMiddleware: RequestHandler,
  maxFileBytes: number,
): RequestHandler {
  return (req, res, next) => {
    uploadMiddleware(req, res, (err: unknown) => {
      if (!err) {
        return next();
      }

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            message: `That file is too large. Files must be smaller than ${describeSize(maxFileBytes)}.`,
          });
        }
        if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(400).json({ message: "Please upload one file at a time." });
        }
        if (
          err.code === "LIMIT_PART_COUNT" ||
          err.code === "LIMIT_FIELD_COUNT" ||
          err.code === "LIMIT_FIELD_KEY" ||
          err.code === "LIMIT_FIELD_VALUE"
        ) {
          return res.status(400).json({
            message: "That upload contained more than a single file. Please upload just the file.",
          });
        }
        return res.status(400).json({ message: "That upload could not be read. Please try again." });
      }

      // Rejections from fileFilter arrive as ordinary Errors, and their messages
      // are written for the person uploading.
      const message = err instanceof Error ? err.message : "That file could not be uploaded.";
      return res.status(400).json({ message });
    });
  };
}

/**
 * Wraps a multer middleware with both protections. Spread the result into the
 * route: `app.post(path, isAuthenticated, ...guardedUpload(...), handler)`.
 */
export function guardedUpload(
  uploadMiddleware: RequestHandler,
  maxFileBytes: number,
): RequestHandler[] {
  return [
    reserveUploadCapacity(maxFileBytes + REQUEST_OVERHEAD_BYTES),
    withUploadErrorHandling(uploadMiddleware, maxFileBytes),
  ];
}
