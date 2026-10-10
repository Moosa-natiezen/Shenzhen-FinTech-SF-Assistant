/**
 * SPII column encryption (I-5, design doc §3.2): AES-256-GCM, AAD bound to
 * column+row, key-version rotation, no plaintext at rest.
 */
import { describe, expect, it } from "vitest";
import {
  SpiiCryptoError,
  decryptSpii,
  encryptSpii,
  loadKeyringFromEnv,
} from "../src/security/spii";

const ring = loadKeyringFromEnv({ SPII_MASTER_KEY: "kms-injected-master-key-material-32b", SPII_KEY_ID: "k1" } as NodeJS.ProcessEnv);
const aad = { column: "wallets.passport_number", owner: "user-123" };

describe("SPII envelopes", () => {
  it("round-trips through encrypt/decrypt", () => {
    const envelope = encryptSpii("P1234567", ring, aad);
    expect(decryptSpii(envelope, ring, aad)).toBe("P1234567");
  });

  it("never persists plaintext in the envelope", () => {
    const envelope = encryptSpii("P1234567", ring, aad);
    expect(envelope).not.toContain("P1234567");
    expect(envelope.startsWith("v1.k1.")).toBe(true);
  });

  it("produces a fresh random ciphertext per encryption (random IV)", () => {
    const a = encryptSpii("same-value", ring, aad);
    const b = encryptSpii("same-value", ring, aad);
    expect(a).not.toBe(b);
  });

  it("rejects ciphertext transplant to another row (AAD binding)", () => {
    const envelope = encryptSpii("P1234567", ring, aad);
    expect(() => decryptSpii(envelope, ring, { column: aad.column, owner: "user-999" })).toThrow(SpiiCryptoError);
  });

  it("rejects ciphertext moved to another column (AAD binding)", () => {
    const envelope = encryptSpii("P1234567", ring, aad);
    expect(() => decryptSpii(envelope, ring, { column: "wallets.national_id", owner: aad.owner })).toThrow(SpiiCryptoError);
  });

  it("detects tampered ciphertext (GCM auth tag)", () => {
    const envelope = encryptSpii("P1234567", ring, aad);
    const parts = envelope.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptSpii(parts.join("."), ring, aad)).toThrow(SpiiCryptoError);
  });

  it("supports 90-day key rotation: old ciphertext stays readable via the keyring", () => {
    const envelope = encryptSpii("P1234567", ring, aad);
    // Rotation: new active key id; old key retained for reads only.
    const rotated = loadKeyringFromEnv({
      SPII_MASTER_KEY: "kms-injected-master-key-material-32b",
      SPII_KEY_ID: "k1",
    } as NodeJS.ProcessEnv);
    const withNewKey = {
      currentKeyId: "k2",
      keys: { ...rotated.keys, k2: Buffer.alloc(32, 7) },
    };
    expect(decryptSpii(envelope, withNewKey, aad)).toBe("P1234567");
    // New writes use the new key.
    const fresh = encryptSpii("P7654321", withNewKey, aad);
    expect(fresh.startsWith("v1.k2.")).toBe(true);
    // A keyring that dropped the old key cannot decrypt old envelopes.
    const withoutOld = { currentKeyId: "k2", keys: { k2: Buffer.alloc(32, 7) } };
    expect(() => decryptSpii(envelope, withoutOld, aad)).toThrow(/rotated out/);
  });

  it("rejects malformed envelopes", () => {
    expect(() => decryptSpii("v1.k1.only-three-parts", ring, aad)).toThrow(SpiiCryptoError);
    expect(() => decryptSpii("", ring, aad)).toThrow(SpiiCryptoError);
  });

  it("refuses weak/missing keys from the environment", () => {
    expect(() => loadKeyringFromEnv({ SPII_MASTER_KEY: "short" } as NodeJS.ProcessEnv)).toThrow(SpiiCryptoError);
  });
});
