/**
 * Copies any files left in the local `uploads/` folder into Replit App Storage.
 *
 * Uploads used to be written to the container filesystem. They now live in App
 * Storage (see server/objectStorage.ts), keyed as `uploads/<filename>` so that
 * the `/uploads/<filename>` URLs already saved in the database keep resolving.
 * This script moves the historical files across so those URLs keep working.
 *
 * Safe to run more than once: it re-uploads and re-verifies, and it does not
 * delete the local copies. It reports a non-zero exit code if any file fails to
 * arrive intact.
 *
 * Usage:  node scripts/migrate-uploads-to-object-storage.mjs
 */
import { Client } from "@replit/object-storage";
import fs from "fs";
import path from "path";

const uploadDir = path.join(process.cwd(), "uploads");

if (!fs.existsSync(uploadDir)) {
  console.log("No local uploads/ folder — nothing to migrate.");
  process.exit(0);
}

const files = fs
  .readdirSync(uploadDir)
  .filter((name) => fs.statSync(path.join(uploadDir, name)).isFile());

if (files.length === 0) {
  console.log("Local uploads/ folder is empty — nothing to migrate.");
  process.exit(0);
}

const client = new Client();
let migrated = 0;
let failed = 0;

for (const name of files) {
  const key = `uploads/${name}`;
  const local = fs.readFileSync(path.join(uploadDir, name));

  // compress:false must match the download side, or the bytes read back differ.
  const upload = await client.uploadFromBytes(key, local, { compress: false });
  if (!upload.ok) {
    console.error(`FAILED to upload ${name}: ${upload.error.message}`);
    failed++;
    continue;
  }

  // Read it back the same way the server will and confirm it is intact.
  const download = await client.downloadAsBytes(key, { decompress: false });
  if (!download.ok) {
    console.error(`FAILED to read back ${name}: ${download.error.message}`);
    failed++;
    continue;
  }

  if (Buffer.compare(local, download.value[0]) !== 0) {
    console.error(`FAILED verification for ${name}: bytes differ after round trip`);
    failed++;
    continue;
  }

  console.log(`ok  ${name} (${local.length} bytes) verified identical`);
  migrated++;
}

console.log(`\n${migrated} of ${files.length} file(s) present and verified in App Storage.`);

if (failed > 0) {
  console.error(`${failed} file(s) failed. The local copies have been left untouched.`);
  process.exit(1);
}
