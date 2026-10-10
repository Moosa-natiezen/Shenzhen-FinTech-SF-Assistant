/**
 * Access Control Matrix conformance — every row of the Security Assessment §1
 * matrix, both "Permitted Operations" and "Restricted Operations" columns.
 */
import { describe, expect, it } from "vitest";
import {
  ALL_APP_ROLES,
  ROLE_PERMISSIONS,
  type AppRole,
  type PermissionResource,
} from "../src/security/permissions";
import { ApiError, can, parseRoles, requirePermission, requireFreshAuth } from "../src/security/guards";

function allows(role: AppRole, resource: PermissionResource, action: string): boolean {
  return (ROLE_PERMISSIONS[role][resource] ?? []).includes(action);
}

describe("roles parse from Better Auth's comma-separated role field", () => {
  it("parses, trims, de-duplicates and drops unknown roles", () => {
    expect(parseRoles("student")).toEqual(["student"]);
    expect(parseRoles("student,sponsor")).toEqual(["student", "sponsor"]);
    expect(parseRoles(" sponsor , student ,sponsor")).toEqual(["sponsor", "student"]);
    expect(parseRoles("hacker,root")).toEqual([]);
    expect(parseRoles(null)).toEqual([]);
    expect(parseRoles(undefined)).toEqual([]);
  });
});

describe("Student tier (Security §1 row 1)", () => {
  it("permits: view personal wallet balances", () => expect(allows("student", "wallet", "read")).toBe(true));
  it("permits: initiate FX conversions", () => expect(allows("student", "fx", "convert")).toBe(true));
  it("permits: route tuition payments (pay)", () => expect(allows("student", "tuition", "pay")).toBe(true));
  it("permits: view personal R_score", () => expect(allows("student", "credit", "readScore")).toBe(true));
  it("restricted: access parent funding source details", () =>
    expect(allows("student", "funding", "readSourceDetails")).toBe(false));
  it("restricted: access administrative API endpoints", () =>
    expect(allows("student", "admin", "access")).toBe(false));
  it("restricted: modify or inspect database schemas", () => {
    expect(allows("student", "dbSchema", "read")).toBe(false);
    expect(allows("student", "dbSchema", "write")).toBe(false);
  });
  it("restricted: initiate credit lines under third-party identities", () =>
    expect(allows("student", "credit", "initiateThirdParty")).toBe(false));
});

describe("Sponsor/Parent tier (Security §1 row 2)", () => {
  it("permits: deposit home currency funds", () => expect(allows("sponsor", "funding", "deposit")).toBe(true));
  it("permits: initiate cross-border student funding transfers", () =>
    expect(allows("sponsor", "funding", "transfer")).toBe(true));
  it("permits: view institutional tuition payment receipts", () =>
    expect(allows("sponsor", "tuition", "readReceipts")).toBe(true));
  it("restricted: alter student host currency account settings", () =>
    expect(allows("sponsor", "wallet", "alterHostSettings")).toBe(false));
  it("restricted: apply for credit products in the student's name", () =>
    expect(allows("sponsor", "credit", "initiateThirdParty")).toBe(false));
  it("restricted: modify university destination routing details", () =>
    expect(allows("sponsor", "tuition", "manageDestinations")).toBe(false));
  it("restricted: administrative endpoints and MFA bypass", () => {
    expect(allows("sponsor", "admin", "access")).toBe(false);
    expect(allows("sponsor", "auth", "bypassMfa")).toBe(false);
  });
});

describe("Compliance & Admin tier (Security §1 row 3)", () => {
  it("permits: inspect flagged/high-risk transactions", () =>
    expect(allows("compliance_admin", "compliance", "inspectFlagged")).toBe(true));
  it("permits: audit FX conversion and ledger settlement logs", () =>
    expect(allows("compliance_admin", "compliance", "auditLedger")).toBe(true));
  it("permits: generate/export Metro 2 credit bureau packages", () =>
    expect(allows("compliance_admin", "credit", "exportMetro2")).toBe(true));
  it("restricted: directly alter raw user wallet balances", () =>
    expect(allows("compliance_admin", "wallet", "overrideBalance")).toBe(false));
  it("restricted: bypass Better Auth MFA", () =>
    expect(allows("compliance_admin", "auth", "bypassMfa")).toBe(false));
  it("restricted: export unencrypted raw PII/SPII columns", () =>
    expect(allows("compliance_admin", "sensitiveData", "exportPlaintext")).toBe(false));
});

describe("system-wide invariants", () => {
  const forbiddenEverywhere: Array<[PermissionResource, string]> = [
    ["auth", "bypassMfa"],
    ["sensitiveData", "exportPlaintext"],
    ["dbSchema", "read"],
    ["dbSchema", "write"],
    ["credit", "initiateThirdParty"],
    ["wallet", "overrideBalance"],
  ];
  it("no role holds any restricted operation (I-2)", () => {
    for (const role of ALL_APP_ROLES) {
      for (const [resource, action] of forbiddenEverywhere) {
        expect(allows(role, resource, action), `${role} must not hold ${resource}:${action}`).toBe(false);
      }
    }
  });
  it("unknown roles grant nothing", () => {
    expect(can([], "wallet", "read")).toBe(false);
  });
  it("requirePermission throws 403 by default", () => {
    expect(() => requirePermission(["sponsor"], "wallet", "read")).toThrowError(ApiError);
    try {
      requirePermission(["sponsor"], "wallet", "read");
    } catch (e) {
      expect((e as ApiError).status).toBe(403);
    }
    expect(() => requirePermission(["student"], "wallet", "read")).not.toThrow();
  });
  it("step-up freshness window rejects stale sessions (I-7)", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(() =>
      requireFreshAuth({ createdAt: new Date("2026-10-10T11:58:00Z") }, 300, now),
    ).not.toThrow();
    expect(() =>
      requireFreshAuth({ createdAt: new Date("2026-10-10T11:00:00Z") }, 300, now),
    ).toThrowError(ApiError);
  });
});
