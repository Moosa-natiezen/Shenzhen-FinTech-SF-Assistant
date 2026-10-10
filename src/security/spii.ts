/**
 * Column-level encryption for SPII (passport numbers, national IDs, SSN/ITIN,
 * bank account numbers) per design doc §3.2: AES-256-GCM before any write.
 *
 * Keys are NEVER stored in the codebase: they are loaded from the environment
 * (in production, injected from AWS/GCP KMS with the doc's 90-day rotation —
 * rotation support here: multiple key versions are accepted, new writes always
 * use the current key, reads accept any listed version).
 *
 * Format: v1.<keyId>.<iv-b64url>.<ciphertext-b64url>.<tag-b64url>
 * AAD binds ciphertext to its column + row so a value can't be moved between rows.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export interface SpiiKeyring {
  /** Active key used for new encryptions. */
  currentKeyId: string;
  keys: Record<string, Buffer>; // keyId -> 32-byte key
}

export class SpiiCryptoError extends Error {}

export function loadKeyringFromEnv(env: NodeJS.ProcessEnv = process.env): SpiiKeyring {
  const currentKeyId = env.SPII_KEY_ID ?? "k1";
  const raw = env.SPII_MASTER_KEY ?? "";
  if (raw.length < 32) {
    throw new SpiiCryptoError(
      "SPII_MASTER_KEY must be provided by the KMS-injected environment (>= 32 chars)",
    );
  }
  // Derive a stable 32-byte AES key from the KMS payload (idempotent).
  const key = createHash("sha256").update(raw, "utf8").digest();
  return { currentKeyId, keys: { [currentKeyId]: key } };
}

export interface AadContext {
  /** Table/column the value belongs to, e.g. "wallets.passport_number". */
  column: string;
  /** Owning row/user id — prevents ciphertext transplant between records. */
  owner: string;
}

export function encryptSpii(plaintext: string, ring: SpiiKeyring, aad: AadContext): string {
  const key = ring.keys[ring.currentKeyId];
  if (!key) throw new SpiiCryptoError(`Unknown SPII key id ${ring.currentKeyId}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(`${aad.column}|${aad.owner}`, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, ring.currentKeyId, base64url(iv), base64url(ct), base64url(tag)].join(".");
}

export function decryptSpii(envelope: string, ring: SpiiKeyring, aad: AadContext): string {
  const parts = envelope.split(".");
  const [version, keyId, ivB64, ctB64, tagB64] = parts;
  if (parts.length !== 5 || version !== VERSION || !keyId || !ivB64 || !ctB64 || !tagB64) {
    throw new SpiiCryptoError("Malformed SPII envelope");
  }
  const key = ring.keys[keyId];
  if (!key) throw new SpiiCryptoError(`Unknown SPII key id ${keyId} (rotated out?)`);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(`${aad.column}|${aad.owner}`, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM auth failure: tampering, wrong AAD, or wrong key.
    throw new SpiiCryptoError("SPII integrity check failed");
  }
}
