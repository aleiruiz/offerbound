import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Google token encryption (SECURITY §6, DATA_MODEL §3.14): AES-256-GCM with a random 12-byte IV
 * per value, stored as `v1:<iv b64>:<ciphertext b64>:<tag b64>`. Changing `TOKEN_ENCRYPTION_KEY`
 * makes old values unreadable by design.
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Thrown by `decryptToken` for anything it cannot decrypt: a malformed value, an unknown version,
 * a tampered part or the wrong key. The message is fixed so it never carries the token, the key or
 * the stored value.
 */
export class TokenDecryptError extends Error {
  constructor() {
    super("The stored token could not be decrypted.");
    this.name = "TokenDecryptError";
  }
}

export function encryptToken(plain: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new RangeError("The token encryption key must be 32 bytes.");
  // An empty value would store an empty ciphertext part, which the v1 format does not allow.
  if (plain === "") throw new RangeError("There is nothing to encrypt.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, ciphertext, tag]
    .map((part) => (typeof part === "string" ? part : part.toString("base64")))
    .join(":");
}

function decodePart(part: string | undefined): Buffer {
  if (part === undefined || !BASE64.test(part)) throw new TokenDecryptError();
  return Buffer.from(part, "base64");
}

export function decryptToken(value: string, key: Buffer): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION || key.length !== KEY_BYTES) {
    throw new TokenDecryptError();
  }
  const iv = decodePart(parts[1]);
  const ciphertext = decodePart(parts[2]);
  const tag = decodePart(parts[3]);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new TokenDecryptError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Authentication failure; the underlying error is dropped on purpose.
    throw new TokenDecryptError();
  }
}
