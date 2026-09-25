/**
 * Shrinking a photo on the phone before it is uploaded.
 *
 * A phone camera writes 4-12 MB per photo, and the server's image limit is
 * 10 MB (`server/uploadLimits.ts`) for a reason it does not want to give up:
 * every upload is buffered in memory under a 64 MB ceiling. So the phone does
 * the shrinking. This is also the only lever on storage cost, because every
 * walkthrough season is kept and a deleted record leaves its file behind.
 *
 * The numbers, and why:
 *
 *   - **2048 px on the long edge.** A hairline crack in drywall is still a
 *     distinct line at that size when zoomed on a phone; at 1600 it starts to
 *     blur into the texture. It is also the size the photo-comparison view
 *     can never make use of more of.
 *   - **JPEG at 0.82.** Below about 0.8 compression blocks appear on plaster
 *     and grout, which is exactly what somebody is trying to photograph.
 *     A 2048 px photo lands at roughly 400-900 KB.
 *   - **Files at or under 1 MB are sent as they are.** Nothing to gain, and
 *     re-encoding a small JPEG only loses a little.
 *   - **GIFs are never touched** (an animation would become one frame) and
 *     nothing that the browser cannot decode is either: the original goes up
 *     and the server's own checks decide.
 *
 * The decision rules are pure so they can be tested without a browser; only
 * `resizeImageForUpload` needs one.
 */

export const RESIZE_MAX_LONG_EDGE_PX = 2048;
export const RESIZE_JPEG_QUALITY = 0.82;
export const RESIZE_SKIP_AT_OR_BELOW_BYTES = 1024 * 1024;

const NEVER_RESIZED = new Set(["image/gif", "image/svg+xml"]);

/** Whether a file is worth trying to shrink at all. Pure. */
export function shouldResizeImage(file: { type: string; size: number }): boolean {
  if (!file.type.startsWith("image/")) return false;
  if (NEVER_RESIZED.has(file.type)) return false;
  return file.size > RESIZE_SKIP_AT_OR_BELOW_BYTES;
}

/**
 * The name a re-encoded file is given. Pure.
 *
 * The server keys its extension, MIME and magic-byte checks on the filename,
 * so a JPEG still called `IMG_0001.HEIC` would be refused for lying about
 * itself. Only the extension changes; the stem is what an RA recognises.
 */
export function jpegFileName(originalName: string): string {
  const trimmed = originalName.trim();
  const dot = trimmed.lastIndexOf(".");
  const stem = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return `${stem || "photo"}.jpg`;
}

/** The size to draw at: the long edge capped, aspect kept. Pure. */
export function fitWithin(width: number, height: number, maxLongEdge = RESIZE_MAX_LONG_EDGE_PX): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxLongEdge) return { width, height };
  const scale = maxLongEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // `imageOrientation: "from-image"` applies the EXIF rotation, so a portrait
  // photo from a phone does not come out on its side. Older WebKit ignores
  // the option rather than failing on it.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // fall through to the <img> route
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new window.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("undecodable"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Returns a JPEG no larger than the cap on its long edge, or the original file
 * whenever shrinking is pointless or impossible. Never throws.
 */
export async function resizeImageForUpload(file: File): Promise<File> {
  if (!shouldResizeImage(file)) return file;
  try {
    const source = await decode(file);
    const width = "naturalWidth" in source ? source.naturalWidth : source.width;
    const height = "naturalHeight" in source ? source.naturalHeight : source.height;
    if (!width || !height) return file;

    const target = fitWithin(width, height);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    // JPEG has no alpha: a transparent PNG drawn straight onto the canvas
    // comes out black where it was clear. White is what paper would be.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(source, 0, 0, target.width, target.height);
    if ("close" in source) source.close();

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", RESIZE_JPEG_QUALITY),
    );
    if (!blob) return file;
    // A JPEG that did not get smaller is not worth the re-encode.
    if (file.type === "image/jpeg" && blob.size >= file.size) return file;
    return new File([blob], jpegFileName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  }
}
