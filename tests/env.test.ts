/** Env hardening (I-5): TLS mandatory, no weak secrets, https in production. */
import { describe, expect, it, beforeEach } from "vitest";
import { loadEnv, resetEnvCache } from "../src/config/env";

const base = {
  DATABASE_URL: "postgres://u:p@ep.x.neon.tech/neondb?sslmode=require",
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "https://app.example.com",
  ALLOWED_ORIGINS: "https://app.example.com",
};

beforeEach(() => resetEnvCache());

describe("loadEnv", () => {
  it("accepts a fully valid config", () => {
    expect(loadEnv({ ...base, NODE_ENV: "production" }).DATABASE_URL).toContain("sslmode=require");
  });
  it("rejects missing sslmode (defaults to prefer)", () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: "postgres://u:p@h/db" })).toThrowError(/sslmode/);
  });
  it("rejects sslmode=disable", () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: "postgres://u:p@h/db?sslmode=disable" })).toThrowError(/sslmode/);
  });
  it("accepts sslmode=verify-full", () => {
    expect(() =>
      loadEnv({ ...base, DATABASE_URL: "postgres://u:p@h/db?sslmode=verify-full" }),
    ).not.toThrow();
  });
  it("rejects non-postgres schemes", () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: "mysql://u:p@h/db?sslmode=require" })).toThrowError(/postgres/);
  });
  it("rejects short secrets", () => {
    expect(() => loadEnv({ ...base, BETTER_AUTH_SECRET: "short" })).toThrowError(/32/);
  });
  it("requires https for URL and origins in production", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production", BETTER_AUTH_URL: "http://app.example.com" })).toThrowError(/https/);
    expect(() =>
      loadEnv({ ...base, NODE_ENV: "production", ALLOWED_ORIGINS: "http://app.example.com" }),
    ).toThrowError(/https/);
  });
  it("allows http origins outside production", () => {
    expect(() =>
      loadEnv({ ...base, BETTER_AUTH_URL: "http://localhost:3000", ALLOWED_ORIGINS: "http://localhost:3000" }),
    ).not.toThrow();
  });
});
