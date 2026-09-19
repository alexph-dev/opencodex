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
import { createClineIO, ClineTransactionError } from "./cline-io";
import { parseClineDocument } from "./cline-document";
import { PARSE_FAILED, defaultIntegrationIO, loadTarget, parseConfig, type IntegrationIO } from "./config-io";
import { INTEGRATION_CLIENTS, resolveIntegrationPaths, type IntegrationClientId } from "./registry";
import { classifyIntegration, exportContextOf, type IntegrationState } from "./state";
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

const PLAIN_KEY = /^[A-Za-z0-9_-]+$/;
const SELECTOR_HINT = /[[\]=]/;

/**
 * One path segment as it may be published.
 *
 * A plain key is structural and safe to name. Anything carrying selector syntax identifies a
 * member chosen at runtime, so it collapses to a wildcard: which entry was selected is exactly the
 * kind of identity this response does not publish. Anything else is not representable, and an
 * unrepresentable segment invalidates the whole path rather than being silently skipped, because
 * skipping it would produce a path that names a different place than the one being changed.
 */
function canonicalSegment(segment: string): string | null {
  if (PLAIN_KEY.test(segment)) return segment;
  if (SELECTOR_HINT.test(segment)) return "*";
  return null;
}

/** A managed schema path, or null when any segment is not representable. */
export function canonicalSchemaPath(path: readonly string[]): string | null {
  if (path.length === 0) return null;
  const segments: string[] = [];
  for (const segment of path) {
    const canonical = canonicalSegment(segment);
    if (canonical === null) return null;
    segments.push(canonical);
  }
  return segments.join(".");
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
    ],
  ];
  return `${PLAN_FINGERPRINT_VERSION}:${digest(JSON.stringify(components))}`;
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
