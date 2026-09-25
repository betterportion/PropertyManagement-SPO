import { test, expect } from "@playwright/test";
import { deflateSync } from "node:zlib";

// Acts as the resident. global-setup puts this resident on a house roster, so
// the submit flow can attach their region/house.
test.use({ storageState: "e2e/.auth/resident.json" });

test.describe("resident submits a maintenance request", () => {
  test("a submitted request actually lands under My requests", async ({ page }) => {
    await page.goto("/submit-request");
    await expect(page.getByRole("heading", { name: "Submit a maintenance request" })).toBeVisible();

    // A unique title so the assertion can't collide with a prior run's row.
    const title = `E2E submitted ${Date.now()}`;
    await page.getByLabel("Issue title").fill(title);
    await page.getByLabel("Location").fill("Kitchen");
    await page.locator("#category").click();
    await page.getByRole("option", { name: "Plumbing" }).click();
    await page.locator("#priority").click();
    await page.getByRole("option", { name: "Medium" }).click();
    await page.getByLabel("Description").fill("The kitchen tap drips overnight.");

    await page.getByTestId("button-submit-request").click();

    // Redirects to My requests, and the new request is really there.
    await expect(page).toHaveURL(/\/my-requests$/);
    await expect(page.getByText(title)).toBeVisible();
  });

  test("blocks submission until a category and priority are chosen", async ({ page }) => {
    await page.goto("/submit-request");
    await page.getByLabel("Issue title").fill("Missing fields");
    await page.getByLabel("Location").fill("Hallway");
    await page.getByLabel("Description").fill("No category or priority picked.");

    await page.getByTestId("button-submit-request").click();

    // Stays on the page and explains what's missing instead of silently failing.
    await expect(page.getByTestId("text-form-error")).toBeVisible();
    await expect(page).toHaveURL(/\/submit-request$/);
  });

  test("a resident can attach a photo when reporting an issue", async ({ page }) => {
    await page.goto("/submit-request");
    const title = `E2E photo request ${Date.now()}`;
    await page.getByLabel("Issue title").fill(title);
    await page.getByLabel("Location").fill("Bathroom");
    await page.locator("#category").click();
    await page.getByRole("option", { name: "Plumbing" }).click();
    await page.locator("#priority").click();
    await page.getByRole("option", { name: "Medium" }).click();
    await page.getByLabel("Description").fill("Leak under the sink; photo attached.");

    // Attach an image via the hidden file input inside the dropzone (a 1×1 PNG).
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.getByTestId("input-file-upload").setInputFiles({ name: "leak.png", mimeType: "image/png", buffer: png });
    await expect(page.getByTestId("request-photo-thumbs")).toBeVisible();

    await page.getByTestId("button-submit-request").click();
    await expect(page).toHaveURL(/\/my-requests$/);

    // The request lands with its photo gallery under My requests.
    await expect(page.getByText(title)).toBeVisible();
    await expect(page.locator('[data-testid^="request-photos-"]').first()).toBeVisible();
  });

  test("a phone-sized photo is shrunk in the browser before it is uploaded", async ({ page }) => {
    // 2026-09 RA review, item 2. The server's image limit is 10 MB and does
    // not move; the phone shrinks the photo instead. This 2000x2000 PNG of
    // noise is ~12 MB, so it only lands because the browser re-encoded it.
    await page.goto("/submit-request");
    await page.getByLabel("Issue title").fill(`E2E big photo ${Date.now()}`);
    await page.getByLabel("Location").fill("Kitchen");
    await page.locator("#category").click();
    await page.getByRole("option", { name: "Plumbing" }).click();
    await page.locator("#priority").click();
    await page.getByRole("option", { name: "Medium" }).click();
    await page.getByLabel("Description").fill("Photo straight off the camera.");

    const big = noisePng(2000, 2000);
    expect(big.length).toBeGreaterThan(10 * 1024 * 1024);

    const upload = page.waitForRequest((r) => r.url().includes("/api/maintenance-request-photos/upload"));
    await page.getByTestId("input-file-upload").setInputFiles({ name: "IMG_4021.png", mimeType: "image/png", buffer: big });
    const sent = await upload;
    const body = sent.postDataBuffer();
    expect(body).not.toBeNull();
    // What went over the wire is a JPEG named after the original, and small.
    expect(body!.toString("latin1")).toContain('filename="IMG_4021.jpg"');
    expect(body!.length).toBeLessThan(10 * 1024 * 1024);

    await expect(page.getByTestId("request-photo-thumbs")).toBeVisible();
  });
});

/**
 * A valid PNG of random RGB noise, built by hand so the test needs no image
 * library. Stored (level 0) deflate keeps it about as big as the raw pixels,
 * which is the point: it has to be over the server's limit.
 */
function noisePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let i = 1; i <= width * 3; i++) raw[row + i] = (Math.random() * 256) | 0;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
