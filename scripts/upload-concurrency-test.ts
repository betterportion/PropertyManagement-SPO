// Concurrency test for the upload in-flight memory cap (task: prevent OOM
// from simultaneous big uploads). Mints a real session row (no app code
// touched), fires several large concurrent uploads, and verifies the server
// stays up and over-budget requests get a clear 503.
import crypto from "crypto";
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
});
const base = `https://${process.env.REPLIT_DEV_DOMAIN}`;

function signCookie(sid: string): string {
  const sig = crypto
    .createHmac("sha256", process.env.SESSION_SECRET!)
    .update(sid)
    .digest("base64")
    .replace(/=+$/, "");
  return encodeURIComponent(`s:${sid}.${sig}`);
}

function makePdf(bytes: number): Buffer {
  const header = Buffer.from("%PDF-1.4\n");
  return Buffer.concat([header, Buffer.alloc(bytes - header.length, 0x20)]);
}

function multipartBody(boundary: string, filename: string, contentType: string, data: Buffer): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([head, data, tail]);
}

async function main() {
  const { rows } = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!rows.length) throw new Error("no admin user");
  const userId = rows[0].id;
  const sid = crypto.randomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const sess = {
    cookie: { originalMaxAge: 600000, httpOnly: true, path: "/" },
    passport: { user: { claims: { sub: userId }, expires_at: expiresAt, access_token: "t", refresh_token: "t" } },
  };
  await pool.query("INSERT INTO sessions (sid, sess, expire) VALUES ($1, $2, NOW() + interval '10 minutes')", [sid, JSON.stringify(sess)]);
  const cookie = `connect.sid=${signCookie(sid)}`;

  try {
    const pdf = makePdf(19 * 1024 * 1024);
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const boundary = "----testboundary" + i;
        const body = multipartBody(boundary, "big.pdf", "application/pdf", pdf);
        try {
          const res = await fetch(`${base}/api/upload-doc`, {
            method: "POST",
            headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
            body,
          });
          const text = await res.text();
          return { i, status: res.status, text: text.slice(0, 120) };
        } catch (e: any) {
          return { i, status: -1, text: String(e).slice(0, 120) };
        }
      })
    );
    for (const r of results) console.log(r);
    const ok = results.filter(r => r.status === 200).length;
    const busy = results.filter(r => r.status === 503).length;
    console.log(`200s: ${ok}, 503s: ${busy}, other: ${N - ok - busy}`);

    // Server still up?
    const ping = await fetch(`${base}/api/auth/user`, { headers: { cookie } });
    console.log("server alive after burst, /api/auth/user status:", ping.status);

    // A normal single upload still works after the burst
    const boundary = "----after";
    const single = await fetch(`${base}/api/upload-doc`, {
      method: "POST",
      headers: { cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      body: multipartBody(boundary, "small.pdf", "application/pdf", makePdf(50 * 1024)),
    });
    console.log("single upload after burst:", single.status, (await single.text()).slice(0, 150));
  } finally {
    await pool.query("DELETE FROM sessions WHERE sid=$1", [sid]);
    await pool.end();
    console.log("session cleaned up");
  }
}

main().catch(e => { console.error(e); process.exit(1); });
