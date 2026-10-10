import { test, expect, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { mintSession } from "./global-setup";
import { MAX_RESIDENT_ACCOUNTS_PER_PROPERTY } from "../shared/residents";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:verify@localhost:55432/postgres";

/**
 * Four resident accounts on one house, with overlap, without widening access
 * (PROJECT_BRIEF.md, Phase 1).
 *
 * The route tests pin the cap and the house rule over HTTP with the storage
 * spied on. What only a browser can show is the thing the brief calls the
 * failure that does not look broken: a student who can see the wrong house.
 * So this spec fills a house to the cap through the real RA flow (roster row,
 * then "Give portal access"), has a fifth refused with the sentence, then
 * signs in as the first and the fourth account and reads what each one sees.
 *
 * Runs as the admin (playwright.config), who creates the two houses and the
 * accounts; the two household sessions are minted the way global-setup mints
 * every session, because sign-in is Google OIDC and cannot run headlessly.
 */

interface House {
  id: string;
  name: string;
  address: string;
  region: string;
  requestId: string;
  requestTitle: string;
}

async function createHouse(api: APIRequestContext, label: string, stamp: string): Promise<House> {
  const name = `E2E ${label} house ${stamp}`;
  const created = await api.post("/api/properties", {
    data: {
      name,
      streetAddress: `${stamp} ${label} Street`,
      city: "San Marcos",
      state: "TX",
      zipCode: "78666",
      region: "Southwest",
      chapter: "Texas State University",
      ownership: "owned",
    },
  });
  expect(created.ok()).toBeTruthy();
  const house = await created.json();

  // One repair on each house, filed by staff, so neither leader filed it: what
  // they see is the house's history, not their own report.
  const requestTitle = `E2E ${label} repair ${stamp}`;
  const filed = await api.post("/api/maintenance-requests", {
    data: {
      title: requestTitle,
      description: `Dripping tap at the ${label} house`,
      category: "Plumbing",
      priority: "medium",
      type: "request",
      status: "pending",
      location: "Kitchen",
      region: house.region,
      buildingAddress: house.address,
    },
  });
  expect(filed.ok()).toBeTruthy();
  return { id: house.id, name, address: house.address, region: house.region, requestId: (await filed.json()).id, requestTitle };
}

/** Puts somebody on the house's roster and gives them portal access; returns the grant's response. */
async function giveAccess(api: APIRequestContext, house: House, n: number, stamp: string) {
  const email = `e2e-house-${stamp}-${n}@test.local`;
  const row = await api.post("/api/residents", {
    data: { propertyId: house.id, firstName: `Leader${n}`, lastName: `E2E${stamp}`, email },
  });
  expect(row.ok()).toBeTruthy();
  const { id: residentId } = await row.json();
  return { email, grant: await api.post(`/api/residents/${residentId}/portal-access`) };
}

test.describe("a house holds four resident accounts and no more", () => {
  test("four leaders see one house's repairs, exactly alike; a fifth is refused in plain words", async ({ request, browser }) => {
    const stamp = `${Date.now()}`;
    const houseA = await createHouse(request, "Alpha", stamp);
    const houseB = await createHouse(request, "Beta", stamp);

    // Fill house A to the cap through the RA's own path.
    const emails: string[] = [];
    for (let n = 1; n <= MAX_RESIDENT_ACCOUNTS_PER_PROPERTY; n++) {
      const { email, grant } = await giveAccess(request, houseA, n, stamp);
      expect(grant.ok(), `account ${n} of ${MAX_RESIDENT_ACCOUNTS_PER_PROPERTY}`).toBeTruthy();
      emails.push(email);
    }

    // The fifth: a sentence naming the house and the four, and nothing written.
    const fifth = await giveAccess(request, houseA, MAX_RESIDENT_ACCOUNTS_PER_PROPERTY + 1, stamp);
    expect(fifth.grant.status()).toBe(409);
    const refusal = (await fifth.grant.json()).message as string;
    expect(refusal).toContain(`already has ${MAX_RESIDENT_ACCOUNTS_PER_PROPERTY} people with access`);
    for (const email of emails) expect(refusal).toContain(email);
    expect(refusal).not.toMatch(/\b(409|error)\b/i);

    // The card on the property page agrees with the server.
    const access = await request.get(`/api/residents/${(await (await request.get("/api/residents")).json()).find((r: { email: string }) => r.email === fifth.email).id}/portal-access`);
    expect(access.ok()).toBeTruthy();
    const card = await access.json();
    expect(card.hasAccess).toBe(false);
    expect(card.houseAccounts).toHaveLength(MAX_RESIDENT_ACCOUNTS_PER_PROPERTY);
    expect(card.limit).toBe(MAX_RESIDENT_ACCOUNTS_PER_PROPERTY);

    // Sign in as the first and the fourth, the way global-setup signs anybody in.
    const pool = new pg.Pool({ connectionString: DATABASE_URL });
    const seen: Record<string, { titles: string[]; ids: string[] }> = {};
    try {
      for (const email of [emails[0], emails[MAX_RESIDENT_ACCOUNTS_PER_PROPERTY - 1]]) {
        const { rows } = await pool.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [email]);
        expect(rows, `an account waiting for ${email}`).toHaveLength(1);
        const cookie = await mintSession(pool, rows[0].id, email);
        const context = await browser.newContext();
        try {
          await context.addCookies([{ name: "connect.sid", value: cookie, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }]);
          const page = await context.newPage();
          await page.goto("/my-requests");
          await expect(page.getByRole("heading", { name: "My requests" })).toBeVisible();
          await expect(page.getByText(houseA.requestTitle)).toBeVisible();
          await expect(page.getByText(houseB.requestTitle)).toHaveCount(0);
          const titles = (await page.locator('[data-testid^="link-request-"]').allInnerTexts()).sort();

          // The list behind the page, from this session, not the admin's.
          const list = await context.request.get("/api/maintenance-requests");
          expect(list.ok()).toBeTruthy();
          const ids = ((await list.json()) as { id: string }[]).map((r) => r.id).sort();
          seen[email] = { titles, ids };
        } finally {
          await context.close();
        }
      }
    } finally {
      await pool.end();
    }

    const [first, fourth] = Object.values(seen);
    expect(first.ids).toContain(houseA.requestId);
    expect(first.ids).not.toContain(houseB.requestId);
    expect(fourth.ids).toEqual(first.ids);
    expect(fourth.titles).toEqual(first.titles);
    // Nothing from the second house reached either of them, by address either.
    expect(first.titles.join("\n")).not.toContain("Beta");
  });
});
