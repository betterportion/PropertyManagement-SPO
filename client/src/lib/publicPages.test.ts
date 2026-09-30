import { describe, expect, it } from "vitest";
import { isPublicPage } from "./publicPages";

describe("isPublicPage", () => {
  it("lets anybody read the privacy notice, signed in or not", () => {
    expect(isPublicPage("/privacy")).toBe(true);
    expect(isPublicPage("/privacy/")).toBe(true);
  });

  it("keeps every other page behind the sign-in", () => {
    for (const path of ["/", "/maintenance", "/settings", "/privacy-policy", "/privacy/edit", "/privacyx"]) {
      expect(isPublicPage(path)).toBe(false);
    }
  });
});
