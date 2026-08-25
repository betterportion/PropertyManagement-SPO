import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import pg from "pg";

/**
 * Signs in the test users without going through Google.
 *
 * Login is OIDC and cannot run headlessly, so this creates the same thing a
 * real login would: a row in the sessions table and the signed cookie that
 * points at it. Both storage-state files below then carry that cookie. The
 * application itself has no test-only login path -- this only works because the
 * test knows SESSION_SECRET, exactly as a developer minting a local session
 * does.
 */

const PORT = process.env.E2E_PORT ?? "5050";
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET ?? "local-test-secret";
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgres://postgres:verify@localhost:55432/postgres";

const PERMISSION_COLUMNS = [
  "can_view_maintenance", "can_manage_maintenance",
  "can_view_walkthroughs", "can_manage_walkthroughs",
  "can_view_assets", "can_manage_assets",
  "can_view_billing", "can_manage_billing",
  "can_view_contacts", "can_manage_contacts",
  "can_manage_users", "can_view_properties", "can_manage_properties",
];

async function ensureUser(
  pool: pg.Pool,
  { id, email, role }: { id: string; email: string; role: string },
) {
  await pool.query(
    `INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)
     ON CONFLICT (id) DO UPDATE SET email = $2, role = $3, is_active = true`,
    [id, email, role],
  );
  const staff = role !== "resident";
  // Mirror the app's computeDefaultPermissions: canViewMaintenance is true for
  // every role (it is how a resident sees their own requests); everything else
  // is staff-only. Getting this wrong makes a resident 403 on their own data.
  const permissionValues = PERMISSION_COLUMNS.map((col) =>
    col === "can_view_maintenance" ? true : staff,
  );
  await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [id]);
  await pool.query(
    `INSERT INTO user_permissions (user_id, ${PERMISSION_COLUMNS.join(", ")}, allowed_regions)
     VALUES ($1, ${PERMISSION_COLUMNS.map((_, i) => `$${i + 2}`).join(", ")}, $${PERMISSION_COLUMNS.length + 2})`,
    [id, ...permissionValues, staff ? ["all"] : null],
  );
}

function signedCookieValue(sid: string): string {
  const sig = createHmac("sha256", SESSION_SECRET).update(sid).digest("base64").replace(/=+$/, "");
  return encodeURIComponent(`s:${sid}.${sig}`);
}

async function mintSession(pool: pg.Pool, userId: string, email: string): Promise<string> {
  const sid = randomBytes(24).toString("hex");
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const expires = new Date(Date.now() + weekMs);
  const expSeconds = Math.floor(expires.getTime() / 1000);
  const sess = {
    cookie: {
      originalMaxAge: weekMs,
      expires: expires.toISOString(),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: false,
    },
    passport: { user: { claims: { sub: userId, email, exp: expSeconds }, expires_at: expSeconds } },
  };
  await pool.query(
    `INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2, $3)`,
    [sid, JSON.stringify(sess), expires],
  );
  return signedCookieValue(sid);
}

async function saveStorageState(cookieValue: string, path: string) {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "connect.sid",
      value: cookieValue,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.storageState({ path });
  await browser.close();
}

export default async function globalSetup() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  try {
    mkdirSync("e2e/.auth", { recursive: true });

    await ensureUser(pool, { id: "e2e-admin", email: "e2e-admin@test.local", role: "admin" });
    await ensureUser(pool, { id: "e2e-resident", email: "e2e-resident@test.local", role: "resident" });

    // Give the resident a request they own, so their dashboard has content.
    const owned = await pool.query(
      `SELECT id FROM maintenance_requests WHERE submitted_by = $1 LIMIT 1`,
      ["e2e-resident@test.local"],
    );
    if (owned.rowCount === 0) {
      const property = (await pool.query(`SELECT region, address FROM properties LIMIT 1`)).rows[0];
      await pool.query(
        `INSERT INTO maintenance_requests
           (title, description, category, priority, status, location, region, building_address, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          "E2E resident request", "Dripping faucet in the kitchen", "Plumbing", "medium",
          "pending", "Kitchen", property?.region ?? "East Central",
          property?.address ?? "1 Main St", "e2e-resident@test.local",
        ],
      );
    }

    const adminCookie = await mintSession(pool, "e2e-admin", "e2e-admin@test.local");
    const residentCookie = await mintSession(pool, "e2e-resident", "e2e-resident@test.local");
    await saveStorageState(adminCookie, "e2e/.auth/admin.json");
    await saveStorageState(residentCookie, "e2e/.auth/resident.json");

    // A few real IDs so specs navigate deterministically instead of guessing.
    const property = (await pool.query(`SELECT id, region, chapter FROM properties WHERE chapter IS NOT NULL LIMIT 1`)).rows[0];
    const assetWithPhoto = (await pool.query(
      `SELECT a.id FROM assets a JOIN asset_photos p ON p.asset_id = a.id LIMIT 1`,
    )).rows[0];
    writeFileSync(
      "e2e/.auth/fixtures.json",
      JSON.stringify(
        {
          baseUrl: BASE_URL,
          propertyId: property?.id ?? null,
          propertyRegion: property?.region ?? null,
          propertyChapter: property?.chapter ?? null,
          assetWithPhotoId: assetWithPhoto?.id ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}
