/**
 * Hardened environment loader. Fail-fast validation before any DB or auth code runs.
 * Design doc §3.2 requires TLS for all Neon connections, so sslmode=require is mandatory.
 */
import { z } from "zod";

const REQUIRED_TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

function assertDatabaseUrlTls(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres:// or postgresql:// scheme");
  }
  const sslmode = parsed.searchParams.get("sslmode") ?? "prefer";
  if (!REQUIRED_TLS_MODES.has(sslmode)) {
    throw new Error(
      "DATABASE_URL must specify sslmode=require (got sslmode=" + sslmode +
      "). Design doc 3.2 requires TLS for all Neon connections.",
    );
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  ALLOWED_ORIGINS: z.string().min(1),
}).superRefine((val, ctx) => {
  if (val.NODE_ENV === "production") {
    if (!val.BETTER_AUTH_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["BETTER_AUTH_URL"], message: "must be https in production" });
    }
    const origins = val.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
    for (const origin of origins) {
      if (!origin.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: ["ALLOWED_ORIGINS"], message: origin + " must be https in production" });
      }
    }
  }
  try {
    assertDatabaseUrlTls(val.DATABASE_URL);
  } catch (e) {
    ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: (e as Error).message });
  }
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => "  - " + i.path.join(".") + ": " + i.message)
      .join("\n");
    throw new Error("Invalid environment configuration:\n" + details);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}
