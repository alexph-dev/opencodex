import { describe, expect, test } from "bun:test";
import {
  PLAN_CHANGE_LIMIT,
  canonicalSchemaPath,
  orderPlanChanges,
  planFingerprint,
  type IntegrationPlanChange,
  type PlanFingerprintInput,
} from "../../src/integrations/mutation-plan";
import type { ManagedContribution } from "../../src/clients/config-export";
import type { OwnershipRecord } from "../../src/integrations/ownership";
import type { JournalEntry } from "../../src/integrations/journal";

const CONFIG_PATH = "/home/example/.cline/config.json";

const RECORD: OwnershipRecord = {
  clientId: "cline",
  configPath: CONFIG_PATH,
  fileFingerprint: "0123456789abcdef",
  blockFingerprint: "fedcba9876543210",
  fragmentPaths: [["providers", "opencodex"]],
  appliedAt: "2026-01-01T00:00:00.000Z",
  opId: "op-base",
};

const CONTRIBUTION: ManagedContribution = {
  clientId: "cline",
  fragments: [{ path: ["providers", "opencodex"], value: { baseUrl: "http://127.0.0.1:10100" } }],
};

const ENTRY: JournalEntry = {
  opId: "op-base",
  clientId: "cline",
  kind: "apply",
  at: "2026-01-01T00:00:00.000Z",
  configPath: CONFIG_PATH,
  snapshot: { kind: "stored", relPath: "snapshots/op-base.json" },
  resultFingerprint: "0123456789abcdef",
  resultAbsent: false,
  priorRecord: null,
};

const BASE: PlanFingerprintInput = {
  operation: "apply",
  clientId: "cline",
  configPath: CONFIG_PATH,
  detectDir: "/home/example/.cline",
  before: "{}",
  contribution: CONTRIBUTION,
  record: RECORD,
  models: [{ namespaced: "anthropic/claude", provider: "anthropic", id: "claude" }],
};

const RESTORE: NonNullable<PlanFingerprintInput["restore"]> = {
  opId: "op-base",
  entry: ENTRY,
  snapshotKind: "stored",
  snapshotText: "{\"a\":1}",
  confirmDrift: false,
};

const RESTORE_BASE: PlanFingerprintInput = { ...BASE, operation: "restore", restore: RESTORE };

describe("integration mutation plan projection", () => {
  test("a managed path keeps plain keys and collapses a selected member", () => {
    expect(canonicalSchemaPath(["providers", "opencodex", "baseUrl"])).toBe("providers.opencodex.baseUrl");
    // Which entry was selected is runtime identity, so the selector becomes a wildcard.
    expect(canonicalSchemaPath(["providers", "[name=opencodex]", "baseUrl"])).toBe("providers.*.baseUrl");
  });

  test("a segment that is not representable invalidates the whole path", () => {
    // An ownership record accepts arbitrary strings, so a path is never trusted because a record
    // carries it. Dropping only the bad segment would name a different place than the real one.
    expect(canonicalSchemaPath(["providers", "../../etc/passwd"])).toBeNull();
    expect(canonicalSchemaPath(["providers", "a key with spaces"])).toBeNull();
    expect(canonicalSchemaPath([])).toBeNull();
  });

  test("changes are deduplicated and ordered by kind then path", () => {
    const input: IntegrationPlanChange[] = [
      { kind: "journal", path: "$journal" },
      { kind: "replace", path: "providers.b" },
      { kind: "add", path: "providers.z" },
      { kind: "replace", path: "providers.a" },
      { kind: "add", path: "providers.z" },
    ];
    expect(orderPlanChanges(input)).toEqual([
      { kind: "add", path: "providers.z" },
      { kind: "replace", path: "providers.a" },
      { kind: "replace", path: "providers.b" },
      { kind: "journal", path: "$journal" },
    ]);
  });

  test("the reported change list is capped and frozen", () => {
    const many: IntegrationPlanChange[] = Array.from({ length: PLAN_CHANGE_LIMIT + 5 }, (_unused, index) => ({
      kind: "add" as const,
      path: `providers.p${String(index).padStart(4, "0")}`,
    }));
    const ordered = orderPlanChanges(many);
    expect(ordered.length).toBe(PLAN_CHANGE_LIMIT);
    // Frozen because a caller that sorted this in place would be editing shared plan state.
    expect(() => (ordered as IntegrationPlanChange[]).push({ kind: "add", path: "providers.extra" })).toThrow();
  });
});

describe("integration plan fingerprint", () => {
  test("is stable for the same inputs and carries its version", () => {
    expect(planFingerprint(BASE)).toBe(planFingerprint({ ...BASE }));
    expect(planFingerprint(BASE).startsWith("p1:")).toBe(true);
  });

  test("every authority input changes it", () => {
    const variants: PlanFingerprintInput[] = [
      BASE,
      { ...BASE, operation: "overwrite" },
      { ...BASE, clientId: "opencode" },
      { ...BASE, profileId: 1 },
      { ...BASE, configPath: "/home/other/.cline/config.json" },
      { ...BASE, detectDir: "/home/other/.cline" },
      // Different bytes, and absent distinguished from empty: restoring over a missing file and
      // over an empty one are different operations.
      { ...BASE, before: "{ }" },
      { ...BASE, before: "" },
      { ...BASE, before: null },
      { ...BASE, contribution: null },
      {
        ...BASE,
        contribution: {
          clientId: "cline",
          fragments: [{ path: ["providers", "opencodex"], value: { baseUrl: "http://127.0.0.1:10101" } }],
        },
      },
      { ...BASE, record: null },
      // The contribution is derived from the model roster, so a changed roster changes what a
      // confirmed apply would write.
      { ...BASE, models: [{ namespaced: "anthropic/claude", provider: "anthropic", id: "claude-2" }] },
      { ...BASE, models: [] },
    ];
    expect(new Set(variants.map(planFingerprint)).size).toBe(variants.length);
  });

  test("restore binds the selected row and the bytes it would publish", () => {
    const variants: PlanFingerprintInput[] = [
      RESTORE_BASE,
      { ...RESTORE_BASE, restore: { ...RESTORE, opId: "op-other" } },
      { ...RESTORE_BASE, restore: { ...RESTORE, entry: { ...ENTRY, resultAbsent: true } } },
      { ...RESTORE_BASE, restore: { ...RESTORE, entry: { ...ENTRY, priorRecord: RECORD } } },
      { ...RESTORE_BASE, restore: { ...RESTORE, snapshotKind: "none" } },
      // Same row and same snapshot kind, different snapshot bytes. Binding only the operation id
      // would leave the bytes that actually land in the user's file outside the confirmation.
      { ...RESTORE_BASE, restore: { ...RESTORE, snapshotText: "{\"a\":2}" } },
      { ...RESTORE_BASE, restore: { ...RESTORE, snapshotText: null } },
      { ...RESTORE_BASE, restore: { ...RESTORE, confirmDrift: true } },
    ];
    expect(new Set(variants.map(planFingerprint)).size).toBe(variants.length);
  });
});
