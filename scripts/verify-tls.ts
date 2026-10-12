/**
 * TLS/cipher verification (T20 / Tech Spec §1: "TLS 1.3 / HTTPS" edge +
 * §3.2 "TLS for all Neon connections").
 *
 * Connects to host:port, negotiates the strongest available session, and
 * reports protocol + cipher. Enforces the launch policy:
 *   - TLS 1.2 minimum (TLS 1.3 preferred),
 *   - AEAD cipher suites only (GCM / CHACHA20-POLY1305),
 *   - no renegotiation-weak suites.
 *
 * Usage:
 *   npx tsx scripts/verify-tls.ts <host> [port=443]
 * Exits non-zero when the endpoint violates policy — usable as a CI gate and
 * as the documented pre-launch check against the Neon endpoint + CDN edge.
 */
import { connect, type ConnectionOptions } from "node:tls";

const WEAK_PROTOCOLS = new Set(["TLSv1", "TLSv1.1"]);
const WEAK_CIPHER = /(RC4|DES|3DES|MD5|NULL|EXPORT|anon|CBC)/i;

export interface TlsReport {
  ok: boolean;
  protocol: string | null;
  cipher: string | null;
  issues: string[];
}

/** Negotiates one connection and evaluates it against the launch policy. */
export function inspectTls(host: string, port: number, opts: ConnectionOptions = {}): Promise<TlsReport> {
  return new Promise((resolve) => {
    const issues: string[] = [];
    let settled = false;
    const finish = (report: TlsReport) => {
      if (settled) return;
      settled = true;
      resolve(report);
    };
    const socket = connect({ host, port, servername: host, ...opts }, () => {
      const protocol = socket.getProtocol();
      const cipher = socket.getCipher();
      if (!protocol || WEAK_PROTOCOLS.has(protocol)) issues.push(`weak protocol: ${protocol ?? "unknown"}`);
      if (!cipher?.name || WEAK_CIPHER.test(cipher.name)) issues.push(`weak cipher: ${cipher?.name ?? "unknown"}`);
      finish({ ok: issues.length === 0, protocol, cipher: cipher?.name ?? null, issues });
      socket.end();
    });
    socket.setTimeout(10_000, () => {
      socket.destroy();
      finish({ ok: false, protocol: null, cipher: null, issues: ["connection timed out"] });
    });
    socket.on("error", (err) => {
      finish({ ok: false, protocol: null, cipher: null, issues: [`connect failed: ${err.message}`] });
    });
  });
}

async function main(): Promise<void> {
  const host = process.argv[2];
  if (!host) {
    console.error("usage: tsx scripts/verify-tls.ts <host> [port]");
    process.exit(2);
  }
  const port = Number(process.argv[3] ?? 443);
  const report = await inspectTls(host, port);
  console.log(`endpoint     : ${host}:${port}`);
  console.log(`protocol     : ${report.protocol ?? "n/a"}`);
  console.log(`cipher       : ${report.cipher ?? "n/a"}`);
  console.log(`policy       : ${report.ok ? "PASS" : "FAIL"}`);
  for (const issue of report.issues) console.log(`  - ${issue}`);
  process.exit(report.ok ? 0 : 1);
}

// Run as a CLI only when invoked directly (tests import inspectTls).
if (process.argv[1]?.endsWith("verify-tls.ts")) {
  await main();
}
