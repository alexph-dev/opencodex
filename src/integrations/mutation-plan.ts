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
import type { ExportModel, ManagedContribution } from "../clients/config-export";
import type { IntegrationClientId } from "./registry";
import type { IntegrationState } from "./state";
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
