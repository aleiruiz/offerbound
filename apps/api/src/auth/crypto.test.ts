import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TokenDecryptError, decryptToken, encryptToken } from "./crypto.js";

const key = Buffer.alloc(32, 7);
const plain = "refresh-token-placeholder";

/** Flips the first byte of one base64 part of a `v1:<iv>:<ciphertext>:<tag>` value. */
function tamper(value: string, part: 1 | 2 | 3): string {
  const parts = value.split(":");
  const bytes = Buffer.from(parts[part] as string, "base64");
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  parts[part] = bytes.toString("base64");
  return parts.join(":");
}

describe("token encryption", () => {
  it("round-trips a token", () => {
    expect(decryptToken(encryptToken(plain, key), key)).toBe(plain);
    const unicode = "tökén-✓-1/2+3=";
    expect(decryptToken(encryptToken(unicode, key), key)).toBe(unicode);
  });

  it("matches /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/", () => {
    const value = encryptToken(plain, key);
    expect(value).toMatch(/^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    const [version, iv, ciphertext, tag] = value.split(":") as [string, string, string, string];
    expect(version).toBe("v1");
    expect(Buffer.from(iv, "base64")).toHaveLength(12);
    expect(Buffer.from(ciphertext, "base64")).toHaveLength(Buffer.byteLength(plain));
    expect(Buffer.from(tag, "base64")).toHaveLength(16);
    expect(value).not.toContain(plain);
  });

  it("produces different ciphertexts for the same input", () => {
    const values = new Set(Array.from({ length: 20 }, () => encryptToken(plain, key)));
    expect(values.size).toBe(20);
    const ivs = new Set([...values].map((value) => value.split(":")[1]));
    expect(ivs.size).toBe(20);
  });

  it("throws TokenDecryptError for a tampered ciphertext, a tampered tag or a different key", () => {
    const value = encryptToken(plain, key);
    expect(() => decryptToken(tamper(value, 2), key)).toThrow(TokenDecryptError);
    expect(() => decryptToken(tamper(value, 3), key)).toThrow(TokenDecryptError);
    expect(() => decryptToken(tamper(value, 1), key)).toThrow(TokenDecryptError);
    expect(() => decryptToken(value, Buffer.alloc(32, 8))).toThrow(TokenDecryptError);
  });

  it("throws TokenDecryptError for values that are not a v1 token", () => {
    const value = encryptToken(plain, key);
    const [, iv, ciphertext, tag] = value.split(":") as [string, string, string, string];
    for (const bad of [
      "",
      plain,
      `v2:${iv}:${ciphertext}:${tag}`,
      `v1:${iv}:${ciphertext}`,
      `v1:${iv}:${ciphertext}:${tag}:extra`,
      `v1:${randomBytes(8).toString("base64")}:${ciphertext}:${tag}`,
      `v1:${iv}:${ciphertext}:${randomBytes(8).toString("base64")}`,
      `v1:${iv}:not base64!:${tag}`,
    ]) {
      expect(() => decryptToken(bad, key), bad).toThrow(TokenDecryptError);
    }
  });

  it("refuses an empty token", () => {
    expect(() => encryptToken("", key)).toThrow(RangeError);
  });

  it("rejects a key that is not 32 bytes", () => {
    expect(() => encryptToken(plain, Buffer.alloc(16))).toThrow(RangeError);
    expect(() => decryptToken(encryptToken(plain, key), Buffer.alloc(16))).toThrow(
      TokenDecryptError,
    );
  });

  it("keeps the token, the key and the stored value out of error messages", () => {
    const value = encryptToken(plain, key);
    for (const run of [
      () => decryptToken(tamper(value, 2), key),
      () => decryptToken(value, Buffer.alloc(32, 8)),
      () => decryptToken(`junk-${plain}`, key),
    ]) {
      try {
        run();
        expect.unreachable("decryptToken did not throw");
      } catch (error) {
        expect(error).toBeInstanceOf(TokenDecryptError);
        const text = `${(error as Error).name} ${(error as Error).message}`;
        expect(text).not.toContain(plain);
        expect(text).not.toContain(value);
        expect(text).not.toContain(key.toString("base64"));
      }
    }
  });
});
