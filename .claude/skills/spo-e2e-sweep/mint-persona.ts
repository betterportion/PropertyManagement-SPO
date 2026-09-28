import { parseArgs } from "node:util";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pg from "pg";
import { mintSession, saveStorageState } from "../../../e2e/global-setup";

/**
 * Creates one test account on a sweep lane's database and signs it in, the
 * same way e2e/global-setup.ts signs in its admin and resident. global-setup
 * only knows those two; an authorization sweep needs any role, any region list,
 * any house link and any of the permission flags.
 *
 *   SESSION_SECRET=<the lane server's secret> \
 *   npx tsx .claude/skills/spo-e2e-sweep/mint-persona.ts \
 *     --db postgres://postgres:verify@localhost:55432/spo_sweep_authz \
 *     --id ra-west --role regional_administrator --regions "West Central" \
 *     --flags canViewMaintenance,canManageMaintenance \
 *     --out <run dir>/authz/ra-west.json
 *
 * --property <id> links a resident account to its house. --inactive creates the
 * account deactivated. Flags not named are false, except canViewMaintenance,
 * which is true unless --no-view-maintenance is passed (the column's default).
 * Prints the account as JSON; --out is the Playwright storage-state file.
 *
 * SESSION_SECRET comes from the environment, not a flag: global-setup reads it
 * when the module loads, which is before any code here runs.
 */

const FLAGS = [
  "canViewMaintenance", "canManageMaintenance",
  "canViewWalkthroughs", "canManageWalkthroughs",
  "canViewAssets", "canManageAssets",
  "canViewBilling", "canManageBilling",
  "canViewContacts", "canManageContacts",
  "canManageUsers", "canViewProperties", "canManageProperties",
  "canViewFinancials", "canManageFinancials",
  "canCompleteWalkthroughs", "canManagePropertySetup", "canViewResourceHub",
] as const;

const ROLES = ["admin", "regional_administrator", "resident"] as const;

const column = (flag: string): string => flag.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    id: { type: "string" },
    role: { type: "string" },
    regions: { type: "string", default: "" },
    flags: { type: "string", default: "" },
    property: { type: "string" },
    inactive: { type: "boolean", default: false },
    "no-view-maintenance": { type: "boolean", default: false },
    out: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(`mint-persona: ${message}`);
  process.exit(1);
}

const { db, id, role, out } = values;
if (!process.env.SESSION_SECRET) fail("SESSION_SECRET must be set to the lane server's secret");
if (!db || !id || !role || !out) fail("--db, --id, --role and --out are required");
if (!ROLES.includes(role as (typeof ROLES)[number])) fail(`--role must be one of ${ROLES.join(", ")}`);

const granted = (values.flags ?? "").split(",").map((f) => f.trim()).filter(Boolean);
const unknown = granted.filter((f) => !FLAGS.includes(f as (typeof FLAGS)[number]));
if (unknown.length > 0) fail(`unknown flag(s) ${unknown.join(", ")}; known: ${FLAGS.join(", ")}`);
if (!values["no-view-maintenance"]) granted.push("canViewMaintenance");

const regions = (values.regions ?? "").split(",").map((r) => r.trim()).filter(Boolean);
const email = `${id}@sweep.test`;

const pool = new pg.Pool({ connectionString: db });
try {
  await pool.query(
    `INSERT INTO users (id, email, first_name, last_name, role, is_active, property_id)
     VALUES ($1, $2, $3, 'Sweep', $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET email = $2, role = $4, is_active = $5, property_id = $6`,
    [id, email, id, role, !values.inactive, values.property ?? null],
  );
  await pool.query(`DELETE FROM user_permissions WHERE user_id = $1`, [id]);
  await pool.query(
    `INSERT INTO user_permissions (user_id, ${FLAGS.map(column).join(", ")}, allowed_regions)
     VALUES ($1, ${FLAGS.map((_, i) => `$${i + 2}`).join(", ")}, $${FLAGS.length + 2})`,
    [id, ...FLAGS.map((f) => granted.includes(f)), regions],
  );

  const cookie = await mintSession(pool, id, email);
  mkdirSync(dirname(out), { recursive: true });
  await saveStorageState(cookie, out);
  console.log(JSON.stringify({ id, email, role, regions, flags: [...new Set(granted)], property: values.property ?? null, active: !values.inactive, storageState: out }));
} finally {
  await pool.end();
}
