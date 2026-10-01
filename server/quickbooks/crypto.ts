/**
 * Encryption at rest for the QuickBooks refresh token.
 *
 * The refresh token is the one credential the portal keeps: Intuit rotates it
 * on use and it expires if left unused, so it has to live somewhere durable.
 * It is stored only as AES-256-GCM ciphertext under QUICKBOOKS_TOKEN_KEY, so a
 * copy of the database alone cannot be used to reach SPO's books. GCM also
 * authenticates: a tampered value, or one written under a different key,
 * fails to decrypt rather than decrypting to garbage.
 *
 * Stored form: "v1:<iv>:<auth tag>:<ciphertext>", each part base64.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Throws when the value was not written under this key, or has been altered. */
export function decryptToken(stored: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== VERSION || !iv || !tag || !ciphertext) {
    throw new Error("Stored QuickBooks token is not in a recognised format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}
