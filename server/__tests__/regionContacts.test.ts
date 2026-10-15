import { describe, expect, it } from "vitest";
import { setRegionContactSchema } from "../../shared/schema";

/** The body an RA sends for their region's emergency contact (doc section 1). */
describe("a region contact as sent from the form", () => {
  it("keeps the name, phone, email and hours, with blanks as null", () => {
    expect(setRegionContactSchema.parse({ name: " Laura Wilson ", phone: "614-633-6629", email: "", hours: "" })).toEqual({
      name: "Laura Wilson",
      phone: "614-633-6629",
      email: null,
      hours: null,
    });
    expect(setRegionContactSchema.parse({ name: "Laura Wilson", phone: "614-633-6629", email: "laura@spo.org", hours: "7 AM to 9 PM" })).toMatchObject({
      email: "laura@spo.org",
      hours: "7 AM to 9 PM",
    });
  });

  it("needs a name and a full phone number, and an email that is one", () => {
    expect(setRegionContactSchema.safeParse({ name: "", phone: "614-633-6629" }).success).toBe(false);
    expect(setRegionContactSchema.safeParse({ name: "Laura", phone: "6146" }).success).toBe(false);
    expect(setRegionContactSchema.safeParse({ name: "Laura", phone: "614-633-6629", email: "not an email" }).success).toBe(false);
  });
});
