/**
 * Value-free planning for integration mutations.
 *
 * An operator confirming "apply", "overwrite", "disable" or "undo" is agreeing to consequences
 * nobody has shown them. This module computes those consequences as bounded managed schema paths
 * and closed change kinds, and binds them to a fingerprint over every input the decision rested
 * on, so a confirmation can be refused when the state it described has moved.
 *
 * Two rules give the output its safety. Nothing here is a value: paths are structural, and a
 * segment that is not representable in the managed grammar is dropped rather than echoed, because
 * an ownership record on disk accepts arbitrary strings and is not a validation authority. And
 * nothing here writes: this module owns no IO, takes no lock, and must never import the writer.
 * The dependency direction is state/ownership/merge into here, and here into the writer and the
 * preview route.
 */
import { createHash } from "node:crypto";
import { canonicalContribution, fingerprint, type OwnershipRecord } from "./ownership";
import { ClientPathError, EXPORT_CLIENTS, type ExportModel, type ManagedContribution } from "../clients/config-export";
import { OPENCODE_PROVIDER_ID } from "../clients/config-export/constants";
import { createClineIO, ClineTransactionError } from "./cline-io";
import { parseClineDocument } from "./cline-document";
import { PARSE_FAILED, defaultIntegrationIO, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import { INTEGRATION_CLIENTS, resolveIntegrationPaths, type IntegrationClientId } from "./registry";
import { classifyIntegration, exportContextOf, type IntegrationState, type StateReason } from "./state";
import { createIntegrationStateStore, type IntegrationStateStore } from "./store";
import type { OcxConfig } from "../types";
import type { JournalEntry } from "./journal";

/**
 * Why a mutation refused. Declared here rather than in the writer so the planner can report a
 * refusal without depending on the module that performs writes; the writer re-exports it, so this
 * is a move rather than a second vocabulary.
 */
export type RefusalReason =
  | "not_installed"
  | "conflict"
  | "unsafe"
  | "non_loopback"
  | "drift_requires_confirm"
  | "snapshot_expired"
  | "write_failed";

export type IntegrationPlanOperation = "apply" | "overwrite" | "disable" | "restore";
export type IntegrationPlanChangeKind = "add" | "replace" | "remove" | "snapshot" | "ownership" | "journal";
export type IntegrationPlanForeignEdit = "none" | "unowned" | "foreign-edit" | "drift";

/**
 * Effects that are not places in the client's document. They carry no disk location and no value,
 * so an operator learns that history will be written without learning where it lives.
 */
export const PLAN_SNAPSHOT_PATH = "$snapshot";
export const PLAN_OWNERSHIP_PATH = "$ownership";
export const PLAN_JOURNAL_PATH = "$journal";

/**
 * Upper bound on reported changes. Above the largest contribution any registered client builds and
 * well below a response worth truncating, so the cap is a guard rather than a routine limit.
 */
export const PLAN_CHANGE_LIMIT = 256;

export interface IntegrationPlanChange {
  readonly kind: IntegrationPlanChangeKind;
  readonly path: string;
}

export interface IntegrationMutationPlan {
  readonly version: 1;
  readonly clientId: IntegrationClientId;
  readonly operation: IntegrationPlanOperation;
  readonly state: IntegrationState;
  readonly foreignEdit: IntegrationPlanForeignEdit;
  readonly changes: readonly IntegrationPlanChange[];
  readonly fingerprint: string;
  readonly canApply: boolean;
  readonly refusalReason?: RefusalReason;
  readonly profileId?: number;
}

/** A position whose observed value is never published, only its presence. */
export const DYNAMIC_SEGMENT = "*";

/**
 * Where each client's managed fragments live, declared rather than inferred.
 *
 * A general "looks like a plain key" rule is not good enough, and Kimi is the proof: it writes one
 * fragment per model at `models.<alias>`, so an alphanumeric allowlist would publish a user's
 * model identifier verbatim. The same rule would accept any plain path sitting in an ownership
 * record, and a record on disk is not a validation authority.
 *
 * So a path is published only when it matches one of these templates exactly. Static segments must
 * match literally, a DYNAMIC_SEGMENT position accepts any observed segment, and the string that
 * leaves this module is the TEMPLATE rather than the observed path. That is what makes publishing
 * a value structurally impossible instead of merely unlikely.
 *
 * The satisfies clause makes a new client a type error here, so nobody can add one whose managed
 * paths silently have no declaration.
 */
const CLIENT_MANAGED_PATHS = {
  opencode: [["provider", OPENCODE_PROVIDER_ID], ["providers", OPENCODE_PROVIDER_ID]],
  pi: [["providers", OPENCODE_PROVIDER_ID]],
  omp: [["providers", OPENCODE_PROVIDER_ID]],
  hermes: [["providers", OPENCODE_PROVIDER_ID]],
  openclaw: [["models", "providers", OPENCODE_PROVIDER_ID]],
  kimi: [["providers", OPENCODE_PROVIDER_ID], ["models", DYNAMIC_SEGMENT]],
  gajae: [["providers", OPENCODE_PROVIDER_ID]],
  dsh: [["llm-pi-ai", "providers", OPENCODE_PROVIDER_ID]],
  mcode: [["custom_provider", OPENCODE_PROVIDER_ID]],
  zcode: [["provider", OPENCODE_PROVIDER_ID]],
  prime: [["providers", OPENCODE_PROVIDER_ID]],
  aside: [["providers", OPENCODE_PROVIDER_ID]],
  raycast: [["providers", `[id=${OPENCODE_PROVIDER_ID}]`]],
  omo: [["providers", OPENCODE_PROVIDER_ID]],
  cline: [
    ["settings", "providers", OPENCODE_PROVIDER_ID],
    ["catalog", "providers", OPENCODE_PROVIDER_ID],
  ],
} satisfies Record<IntegrationClientId, readonly (readonly string[])[]>;

/** Not a configuration surface. Exported so a parity case can compare it against the shipped clients. */
export const MANAGED_PATH_TEMPLATES: Readonly<Record<IntegrationClientId, readonly (readonly string[])[]>> = CLIENT_MANAGED_PATHS;

function matchesTemplate(template: readonly string[], path: readonly string[]): boolean {
  if (template.length !== path.length) return false;
  return template.every((segment, index) => {
    const observed = path[index];
    if (observed === undefined || observed.length === 0) return false;
    return segment === DYNAMIC_SEGMENT || segment === observed;
  });
}

/**
 * The managed schema path this change touches, or null when the path is outside the client's
 * declared grammar.
 *
 * Null is not an error to work around. A path nobody declared is either a record written by a
 * different version or something arbitrary, and neither is safe to name, so the caller reports the
 * fixed ownership pseudo-path or a refusal instead of inventing a description.
 */
export function canonicalSchemaPath(clientId: IntegrationClientId, path: readonly string[]): string | null {
  if (path.length === 0) return null;
  for (const template of CLIENT_MANAGED_PATHS[clientId]) {
    if (matchesTemplate(template, path)) return template.join(".");
  }
  return null;
}

const KIND_ORDER: readonly IntegrationPlanChangeKind[] = ["add", "replace", "remove", "snapshot", "ownership", "journal"];

/**
 * Deterministic, deduplicated and capped. Deterministic because the fingerprint is taken over this
 * projection, so an unstable order would stale a plan that did not change.
 */
export function orderPlanChanges(changes: readonly IntegrationPlanChange[]): readonly IntegrationPlanChange[] {
  const seen = new Set<string>();
  const unique: IntegrationPlanChange[] = [];
  for (const change of changes) {
    const key = `${change.kind}\u0000${change.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(change);
  }
  unique.sort((left, right) => {
    const byKind = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
    if (byKind !== 0) return byKind;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  return Object.freeze(unique.slice(0, PLAN_CHANGE_LIMIT));
}

/**
 * Every input the plan's authority rests on.
 *
 * `models` is here because the desired contribution is derived from it, so a model roster that
 * changed between preview and commit changes what would be written. `snapshot` carries a digest of
 * the bytes a restore would actually publish rather than only the operation id, because the id
 * names the row and the bytes are what lands in the user's file.
 */
export interface PlanFingerprintInput {
  readonly operation: IntegrationPlanOperation;
  readonly clientId: IntegrationClientId;
  readonly profileId?: number;
  readonly configPath: string;
  readonly detectDir: string;
  /**
   * What the detect directory actually was when observed, not merely where it is.
   *
   * Binding only the path leaves a confirmation valid across an uninstall: the contribution is
   * unchanged, so every other component matches, while the answer to "is this client installed"
   * has flipped. The observed kind is the input the not_installed refusal is derived from.
   */
  readonly installKind: string;
  /**
   * Whether admission policy blocks this integration, which is the non_loopback refusal's input.
   *
   * Config eligibility can change without touching the file, the record or the contribution, so a
   * plan that did not bind it could be confirmed after the proxy stopped being a legal target.
   */
  readonly admissionBlocked: boolean;
  /** Exact current bytes, or null when the target is missing. Missing and empty are not equal. */
  readonly before: string | null;
  readonly contribution: ManagedContribution | null;
  readonly record: OwnershipRecord | null;
  readonly models: readonly ExportModel[];
  readonly restore?: {
    readonly opId: string;
    readonly entry: JournalEntry;
    readonly snapshotKind: string;
    /** Digest of the snapshot's exact text, or null when it holds none. */
    readonly snapshotText: string | null;
    readonly confirmDrift: boolean;
    /**
     * Whether the target has changed since the operation being undone, which is the
     * drift_requires_confirm predicate. Passed in rather than recomputed so the plan and the
     * mutation read drift from the same comparison.
     */
    readonly driftsFromResult: boolean;
  };
}

const PLAN_FINGERPRINT_VERSION = "p1";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * An opaque optimistic-concurrency token, not authorization.
 *
 * Longer than the 16-hex ownership fingerprint because this one is supplied by a caller and
 * compared for equality, so accidental collision matters more than it does for a stored digest.
 * The version prefix means a future input set invalidates old tokens instead of silently
 * comparing two different meanings.
 */
export function planFingerprint(input: PlanFingerprintInput): string {
  const restore = input.restore;
  const components = [
    PLAN_FINGERPRINT_VERSION,
    input.operation,
    input.clientId,
    input.profileId === undefined ? null : input.profileId,
    input.configPath,
    input.detectDir,
    input.installKind,
    input.admissionBlocked,
    input.before === null ? "\u0000absent" : fingerprint(input.before),
    input.contribution === null ? null : fingerprint(canonicalContribution(input.contribution)),
    input.record === null ? null : fingerprint(JSON.stringify(input.record)),
    fingerprint(JSON.stringify(input.models)),
    restore === undefined ? null : [
      restore.opId,
      fingerprint(JSON.stringify(restore.entry)),
      restore.snapshotKind,
      restore.snapshotText === null ? "\u0000none" : fingerprint(restore.snapshotText),
      restore.confirmDrift,
      restore.driftsFromResult,
    ],
  ];
  return `${PLAN_FINGERPRINT_VERSION}:${digest(JSON.stringify(components))}`;
}

/** The observation facts a plan is derived from, beside the fingerprint inputs. */
export interface PlanInput extends PlanFingerprintInput {
  readonly classified: { readonly state: IntegrationState; readonly reason?: StateReason };
}

function foreignEditOf(input: PlanInput): IntegrationPlanForeignEdit {
  if (input.restore?.driftsFromResult) return "drift";
  if (input.classified.reason === "unowned-key") return "unowned";
  if (input.classified.reason === "foreign-edit") return "foreign-edit";
  return "none";
}

/**
 * Why this operation would refuse, in the writer's own order.
 *
 * The order is not cosmetic. An uninstalled client is reported as not installed rather than as
 * whatever its leftover file happens to classify as, and an unreadable or unparseable file is
 * reported before either, because that is the sequence the writer itself refuses in. A plan that
 * named a different reason than the mutation would name is worse than no plan.
 */
function refusalOf(input: PlanInput): RefusalReason | undefined {
  if (input.classified.state === "unsafe") return "unsafe";
  if (input.installKind !== "dir") return "not_installed";
  if (input.admissionBlocked) return "non_loopback";
  if (input.operation === "restore") {
    if (input.restore === undefined) return "unsafe";
    if (input.restore.snapshotKind === "expired") return "snapshot_expired";
    if (input.restore.driftsFromResult && !input.restore.confirmDrift) return "drift_requires_confirm";
    return undefined;
  }
  // Overwrite exists precisely to proceed through a conflict the operator has been shown.
  if (input.classified.state === "conflict" && input.operation !== "overwrite") return "conflict";
  return undefined;
}

function ownedPath(record: OwnershipRecord | null, path: readonly string[]): boolean {
  return (record?.fragmentPaths ?? []).some(owned =>
    owned.length === path.length && owned.every((segment, index) => segment === path[index]));
}

/**
 * The managed places this operation would touch, plus the history it would write.
 *
 * A path that does not canonicalize is omitted rather than guessed at. For a shipped client that
 * cannot happen, and the parity case proves it; what it does cover is a record written by another
 * version, where declining to describe a path is the honest answer and the fixed ownership entry
 * still tells the operator that ownership changes.
 */
function changesOf(input: PlanInput): readonly IntegrationPlanChange[] {
  const changes: IntegrationPlanChange[] = [];
  if (input.operation === "apply" || input.operation === "overwrite") {
    for (const fragment of input.contribution?.fragments ?? []) {
      const path = canonicalSchemaPath(input.clientId, fragment.path);
      if (path === null) continue;
      changes.push({ kind: ownedPath(input.record, fragment.path) ? "replace" : "add", path });
    }
  }
  if (input.operation === "disable" || input.operation === "restore") {
    for (const owned of input.record?.fragmentPaths ?? []) {
      const path = canonicalSchemaPath(input.clientId, owned);
      if (path === null) continue;
      changes.push({ kind: "remove", path });
    }
  }
  if (input.operation === "restore") {
    for (const fragment of input.restore?.entry.priorRecord?.fragmentPaths ?? []) {
      const path = canonicalSchemaPath(input.clientId, fragment);
      if (path === null) continue;
      changes.push({ kind: "replace", path });
    }
  }
  changes.push({ kind: "snapshot", path: PLAN_SNAPSHOT_PATH });
  changes.push({ kind: "ownership", path: PLAN_OWNERSHIP_PATH });
  changes.push({ kind: "journal", path: PLAN_JOURNAL_PATH });
  return orderPlanChanges(changes);
}

/**
 * The whole plan, value-free.
 *
 * A refused plan is still worth returning: knowing that undo is blocked because the backup expired
 * is the answer an operator needs, and it carries no more detail than an allowed one.
 */
export function buildMutationPlan(input: PlanInput): IntegrationMutationPlan {
  const refusalReason = refusalOf(input);
  return Object.freeze({
    version: 1 as const,
    clientId: input.clientId,
    operation: input.operation,
    state: input.classified.state,
    foreignEdit: foreignEditOf(input),
    changes: refusalReason === undefined ? changesOf(input) : Object.freeze([]),
    fingerprint: planFingerprint(input),
    canApply: refusalReason === undefined,
    ...(refusalReason === undefined ? {} : { refusalReason }),
    ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
  });
}

/**
 * What a mutation is asked to do. Declared here because the observation below consumes it and the
 * planner must not depend on the writer; the writer re-exports it, so callers are unaffected.
 */
export interface IntegrationWriteInput {
  clientId: IntegrationClientId;
  models: readonly ExportModel[];
  config: OcxConfig;
  port: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
  store?: IntegrationStateStore;
  io?: IntegrationIO;
  /** Frozen once by the async coordinator; synchronous callers may omit it. */
  resolvedPaths?: { configPath: string; detectDir: string };
}

/** A refusal in the planner's own vocabulary, so observation does not depend on the writer's result type. */
export interface IntegrationObservationFailure {
  readonly reason: RefusalReason;
  readonly state: IntegrationState;
  readonly message: string;
  readonly snapshotPath?: string;
  /** A Cline transaction left residue that only a mutation may clear. */
  readonly residual?: boolean;
}

function observationFailure(
  reason: RefusalReason,
  state: IntegrationState,
  message: string,
  snapshotPath?: string,
): IntegrationObservationFailure {
  return { reason, state, message, ...(snapshotPath ? { snapshotPath } : {}) };
}

/**
 * What preview and mutation are allowed to touch while looking.
 *
 * Both are false for a preview and both are true for a mutation, and neither defaults, because the
 * difference is the whole safety argument. `maintenance` runs pending snapshot pruning, which
 * writes; `recover` lets the Cline adapter repair a pending transaction, which also writes. A
 * preview that quietly inherited either would be a mutation wearing a read's name.
 */
export interface ObservationEffects {
  readonly maintenance: boolean;
  readonly recover: boolean;
}

/**
 * Detect, gate, read, parse and classify, once, for both preview and mutation.
 *
 * Extracted from the writer so a plan and the mutation it authorizes rest on the same
 * classification rather than two independent reads that can disagree. The ordering of refusals is
 * load-bearing and is preserved exactly as the writer had it.
 */
export function observeIntegration(input: IntegrationWriteInput, effects: ObservationEffects) {
  const store = input.store ?? createIntegrationStateStore();
  let io = input.io ?? defaultIntegrationIO(store);
  const clientId = input.clientId;
  const spec = INTEGRATION_CLIENTS[clientId];
  const exportSpec = EXPORT_CLIENTS[clientId];
  /*
   * Resolution itself can refuse: a relative OPENCLAW_* selector is rejected
   * because we cannot know the gateway's working directory. That is a refusal
   * about the user's configuration, not an internal fault, so it must not
   * escape as an exception — the collection route would answer 500 for the
   * whole Integrations page because one client is misconfigured.
   */
  let configPath: string;
  let detectDir: string;
  try {
    /*
     * Resolve the PAIR, never one half.
     *
     * The coordinated path hands us a frozen pair, but applyIntegration,
     * refreshIntegration and disableIntegration are public and may be called
     * without one. Resolving configPath here and detectDir separately later let
     * an Aside account switch land between the two, so a direct apply could
     * verify account 1 was installed and then write account 0's catalog.
     */
    const resolved = input.resolvedPaths ?? resolveIntegrationPaths(clientId, input.env, input.home);
    configPath = resolved.configPath;
    detectDir = resolved.detectDir;
    if (clientId === "cline") io = createClineIO(io, configPath, store, effects.recover);
  } catch (error) {
    if (error instanceof ClineTransactionError) {
      return { failed: { ...observationFailure("unsafe", "unsafe", error.message, error.snapshotPath), residual: true } } as const;
    }
    if (!(error instanceof ClientPathError)) throw error;
    return { failed: observationFailure("unsafe", "unsafe", error.message) } as const;
  }
  // Pruning writes, so only a mutation may perform it. Preview reports the state it finds.
  if (effects.maintenance) store.retryPendingPrunes();

  const target = loadTarget(io, configPath);
  if (!target.ok) {
    return {
      failed: observationFailure("unsafe", "unsafe",
        target.why === "read-failed"
          ? `${configPath} exists but could not be read`
          : `${configPath} is not a regular file`),
    } as const;
  }
  const before = target.before;
  const parsed = clientId === "cline" ? parseClineDocument(before) : parseConfig(before, exportSpec.format);
  if (parsed === PARSE_FAILED) {
    return { failed: observationFailure("unsafe", "unsafe",
      `${configPath} could not be parsed, or holds something opencodex cannot rewrite without changing it (a non-finite number, a large integer or a tiny one a rewrite would round, -0, a duplicate member, or nesting deeper than 1000 levels)`) } as const;
  }
  const contribution = exportSpec.buildContribution(exportContextOf(input));
  // A record proves ownership of the file it was written FOR. Matching only by
  // client id let a record for one home authorize a write to another whose
  // bytes happened to hash the same — which deleted a config we never touched.
  const stored = store.readRecords()[clientId] ?? null;
  const record = stored && stored.clientId === clientId && stored.configPath === configPath
    ? stored
    : null;
  // `configPath`/`clientId` are load-bearing, not decoration: a record proves
  // ownership of ONE file, and the writer mutates whatever path resolves NOW.
  // Without them a record written for another home directory would grant
  // ownership here and disable would delete fragments it never wrote.
  const classified = classifyIntegration({
    fileText: before, fileIsRegular: true, parsed, record, contribution, configPath, clientId,
  });
  return { failed: undefined, store, io, clientId, spec, exportSpec, configPath, detectDir, before, parsed, contribution, record, classified } as const;
}
