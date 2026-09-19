import { describe, expect, test } from "bun:test";
import {
  MANAGED_PATH_TEMPLATES,
  PLAN_CHANGE_LIMIT,
  buildMutationPlan,
  canonicalSchemaPath,
  orderPlanChanges,
  planFingerprint,
  type IntegrationPlanChange,
  type PlanInput,
  type PlanFingerprintInput,
} from "../../src/integrations/mutation-plan";
import {
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  type ExportContext,
  type ExportModel,
  type ManagedContribution,
} from "../../src/clients/config-export";
import type { OwnershipRecord } from "../../src/integrations/ownership";
import type { JournalEntry } from "../../src/integrations/journal";
import type { OcxConfig } from "../../src/types";

const FIXTURE_MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
  { namespaced: "gpt-5.5", provider: "openai", id: "gpt-5.5", native: true, contextWindow: 400_000 },
];

const FIXTURE_CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

function fixtureContext(): ExportContext {
  return { baseUrl: "http://127.0.0.1:10100/v1", models: FIXTURE_MODELS, config: FIXTURE_CONFIG };
}

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

const CANARY = "canary-value-must-not-be-published";

const CONTRIBUTION: ManagedContribution = {
  clientId: "cline",
  fragments: [
    { path: ["settings", "providers", "opencodex"], value: { baseUrl: "http://127.0.0.1:10100", apiKey: CANARY } },
    { path: ["catalog", "providers", "opencodex"], value: { models: [CANARY] } },
  ],
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
  installKind: "dir",
  admissionBlocked: false,
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
  driftsFromResult: false,
};

const RESTORE_BASE: PlanFingerprintInput = { ...BASE, operation: "restore", restore: RESTORE };

describe("integration mutation plan projection", () => {
  test("a declared managed path is published as its template", () => {
    expect(canonicalSchemaPath("cline", ["settings", "providers", "opencodex"])).toBe("settings.providers.opencodex");
    expect(canonicalSchemaPath("raycast", ["providers", "[id=opencodex]"])).toBe("providers.[id=opencodex]");
  });

  test("a dynamic position never publishes the member it selected", () => {
    // Kimi writes one fragment per model, so this position holds a user's model alias. An
    // alphanumeric allowlist would have emitted it verbatim.
    const path = canonicalSchemaPath("kimi", ["models", "kimi-k2-private-alias"]);
    expect(path).toBe("models.*");
    expect(path).not.toContain("kimi-k2-private-alias");
  });

  test("a path outside the client's declared grammar is refused, not described", () => {
    // An ownership record accepts arbitrary strings, so a path is never published because a record
    // carries it. Depth, a foreign static segment and another client's shape all fail closed.
    expect(canonicalSchemaPath("kimi", ["models", "alias", "contextWindow"])).toBeNull();
    expect(canonicalSchemaPath("pi", ["providers", "someone-elses-provider"])).toBeNull();
    expect(canonicalSchemaPath("pi", ["settings", "providers", "opencodex"])).toBeNull();
    expect(canonicalSchemaPath("cline", ["..", "..", "etc"])).toBeNull();
    expect(canonicalSchemaPath("cline", [])).toBeNull();
  });

  test("every path a shipped client actually writes canonicalizes through its own templates", () => {
    // The declarations are a second copy of what the exporters do, so the only assertion worth
    // making is against real builder output. A template list that merely exists proves nothing.
    for (const clientId of EXPORT_CLIENT_IDS) {
      expect(MANAGED_PATH_TEMPLATES[clientId].length, clientId).toBeGreaterThan(0);
      const contribution = EXPORT_CLIENTS[clientId].buildContribution(fixtureContext());
      expect(contribution.fragments.length, clientId).toBeGreaterThan(0);
      for (const fragment of contribution.fragments) {
        const canonical = canonicalSchemaPath(clientId, fragment.path);
        expect(canonical, `${clientId}: ${fragment.path.join(".")}`).not.toBeNull();
        // A dynamic position must not carry its observed value into the published path.
        for (const segment of fragment.path) {
          if (!MANAGED_PATH_TEMPLATES[clientId].some(template => template.includes(segment))) {
            expect(canonical, `${clientId} leaked ${segment}`).not.toContain(segment);
          }
        }
      }
    }
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
      // The contribution is identical across an uninstall and across a change in admission
      // eligibility, so binding the path alone would keep a stale confirmation valid.
      { ...BASE, installKind: "missing" },
      { ...BASE, installKind: "file" },
      { ...BASE, admissionBlocked: true },
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
      { ...RESTORE_BASE, restore: { ...RESTORE, driftsFromResult: true } },
    ];
    expect(new Set(variants.map(planFingerprint)).size).toBe(variants.length);
  });
});

const PLAN_BASE: PlanInput = { ...BASE, classified: { state: "absent" } };

describe("integration mutation plan", () => {
  test("an allowed apply names every managed place and the history it writes", () => {
    const plan = buildMutationPlan(PLAN_BASE);
    expect(plan.canApply).toBe(true);
    expect(plan.refusalReason).toBeUndefined();
    expect(plan.changes).toEqual([
      { kind: "add", path: "catalog.providers.opencodex" },
      { kind: "add", path: "settings.providers.opencodex" },
      { kind: "snapshot", path: "$snapshot" },
      { kind: "ownership", path: "$ownership" },
      { kind: "journal", path: "$journal" },
    ]);
  });

  test("a previously owned place is a replacement rather than an addition", () => {
    const plan = buildMutationPlan({
      ...PLAN_BASE,
      classified: { state: "stale" },
      record: { ...RECORD, fragmentPaths: [["settings", "providers", "opencodex"]] },
    });
    expect(plan.changes).toContainEqual({ kind: "replace", path: "settings.providers.opencodex" });
    expect(plan.changes).toContainEqual({ kind: "add", path: "catalog.providers.opencodex" });
  });

  test("no configured value reaches the plan", () => {
    const plan = buildMutationPlan(PLAN_BASE);
    expect(JSON.stringify(plan)).not.toContain(CANARY);
    expect(JSON.stringify(plan)).not.toContain(CONFIG_PATH);
  });

  test("refusals follow the writer's order and report no places", () => {
    // Unsafe is decided before the install check, exactly as the writer refuses.
    expect(buildMutationPlan({ ...PLAN_BASE, classified: { state: "unsafe", reason: "unparseable" }, installKind: "missing" }).refusalReason)
      .toBe("unsafe");
    expect(buildMutationPlan({ ...PLAN_BASE, installKind: "missing" }).refusalReason).toBe("not_installed");
    expect(buildMutationPlan({ ...PLAN_BASE, admissionBlocked: true }).refusalReason).toBe("non_loopback");
    const refused = buildMutationPlan({ ...PLAN_BASE, installKind: "missing" });
    expect(refused.canApply).toBe(false);
    expect(refused.changes).toEqual([]);
  });

  test("overwrite is the operation allowed through a conflict", () => {
    const conflicted: PlanInput = { ...PLAN_BASE, classified: { state: "conflict", reason: "foreign-edit" } };
    expect(buildMutationPlan(conflicted).refusalReason).toBe("conflict");
    expect(buildMutationPlan({ ...conflicted, operation: "overwrite" }).canApply).toBe(true);
    expect(buildMutationPlan(conflicted).foreignEdit).toBe("foreign-edit");
  });

  test("restore reports an expired backup and unconfirmed drift", () => {
    const plan: PlanInput = { ...RESTORE_BASE, classified: { state: "current" } };
    expect(buildMutationPlan({ ...plan, restore: { ...RESTORE, snapshotKind: "expired" } }).refusalReason)
      .toBe("snapshot_expired");
    const drifted = buildMutationPlan({ ...plan, restore: { ...RESTORE, driftsFromResult: true } });
    expect(drifted.refusalReason).toBe("drift_requires_confirm");
    expect(drifted.foreignEdit).toBe("drift");
    expect(buildMutationPlan({ ...plan, restore: { ...RESTORE, driftsFromResult: true, confirmDrift: true } }).canApply).toBe(true);
  });
});
