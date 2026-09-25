import { describe, it, expect } from "vitest";
import {
  RESIZE_MAX_LONG_EDGE_PX,
  RESIZE_SKIP_AT_OR_BELOW_BYTES,
  fitWithin,
  jpegFileName,
  shouldResizeImage,
} from "./resizeImage";

const MB = 1024 * 1024;

describe("shouldResizeImage", () => {
  it("shrinks a big photo and leaves a small one alone", () => {
    expect(shouldResizeImage({ type: "image/jpeg", size: 6 * MB })).toBe(true);
    expect(shouldResizeImage({ type: "image/png", size: 2 * MB })).toBe(true);
    expect(shouldResizeImage({ type: "image/jpeg", size: RESIZE_SKIP_AT_OR_BELOW_BYTES })).toBe(false);
  });

  it("never touches a GIF, an SVG or a non-image", () => {
    // A GIF would come back as one frame; a PDF is not ours to decode.
    expect(shouldResizeImage({ type: "image/gif", size: 8 * MB })).toBe(false);
    expect(shouldResizeImage({ type: "image/svg+xml", size: 8 * MB })).toBe(false);
    expect(shouldResizeImage({ type: "application/pdf", size: 8 * MB })).toBe(false);
  });
});

describe("jpegFileName", () => {
  it("keeps the stem and swaps the extension, because the server checks the name", () => {
    expect(jpegFileName("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
    expect(jpegFileName("kitchen sink.png")).toBe("kitchen sink.jpg");
    expect(jpegFileName("photo")).toBe("photo.jpg");
  });

  it("does not produce a bare extension from a dotfile or an empty name", () => {
    expect(jpegFileName(".jpeg")).toBe(".jpeg.jpg");
    expect(jpegFileName("  ")).toBe("photo.jpg");
  });
});

describe("fitWithin", () => {
  it("caps the long edge and keeps the aspect ratio", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: RESIZE_MAX_LONG_EDGE_PX, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: RESIZE_MAX_LONG_EDGE_PX });
  });

  it("leaves a photo already within the cap at its own size", () => {
    expect(fitWithin(1200, 900)).toEqual({ width: 1200, height: 900 });
    expect(fitWithin(2048, 100)).toEqual({ width: 2048, height: 100 });
  });
});
