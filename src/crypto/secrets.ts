import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

/** Encrypt plaintext with AES-256-GCM. Returns base64(nonce|tag|ciphertext). */
export function encryptSecret(masterKey: Buffer, plaintext: string): string {
  if (masterKey.length !== 32) {
    throw new Error("masterKey must be 32 bytes");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGO, masterKey, nonce);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, enc]).toString("base64");
}

/** Decrypt payload produced by encryptSecret. */
export function decryptSecret(masterKey: Buffer, payload: string): string {
  if (masterKey.length !== 32) {
    throw new Error("masterKey must be 32 bytes");
  }
  const buf = Buffer.from(payload, "base64");
  // 12-byte nonce + 16-byte tag is a complete payload: GCM ciphertext for the
  // empty string is zero bytes, so "" must round-trip rather than be rejected.
  if (buf.length < 12 + 16) throw new Error("invalid secret payload");
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, masterKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    "utf8",
  );
}
