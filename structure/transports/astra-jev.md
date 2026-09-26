# Astra-Jev Effort

## Adaptive Astra-Jev effort

`src/server/responses/astra-jev.ts` owns the optional request-local policy. Only the exact
`openai/Astra-Jev` native Responses selection, validated by the additive alias owner and resolved
to canonical `openai/gpt-6-astra` forwarding, can evaluate. `OCX_ASTRA_JEV_ENABLED=1` opts in;
the existing definition-site key resolver reads `$TYPESAFE_API_KEY`. The default is off. No new
provider, durable configuration entity, journal, relay or native history writer is introduced.

`request-prepare.ts` captures public context after existing continuation expansion and before
private-payload repair. Missing, corrupt and scope-mismatched parents retain this release's
`previous_response_not_found` error. Evaluation runs after continuation and final route admission,
before native effort normalization. The final adapter follows `route.staticPolicy`, not a fresh
provider lookup. HTTP and inbound WebSocket share one invocation holder; retries reuse its
decision. Native compact and warmup bypass evaluation. Existing pins, caps and ladder constraints
remain authoritative, and `src/responses/request-effort.ts` shares the native Ultra-to-Max inference
boundary without introducing a separate delegation/session mode.

`astra-jev-context.ts` projects only bounded public messages, instructions as state data, public
reasoning summaries and tool calls/results. Private reasoning and encrypted blobs are excluded.
Unknown items, native configuration updates, compaction, incomplete context, non-text content in
the current user turn and unproven ancestry skip evaluation. Historical user image/audio/file parts
may instead become a fixed unknown-content marker while all available text remains projected; their
bytes and semantics are withheld. Such a complete projection is `withheld`, never `full`, and a
lower Jev choice is retained diagnostically but vetoed because the missing media may contain
constraints. `astra-jev-context-selection.ts` keeps short
projections unchanged; before sampling, `astra-jev-repeated-context.ts` losslessly represents exact
repeated user/system/developer messages when their complete original projection exceeds the budget.
The first occurrence retains every text part and receives an evaluator-only `context_message_id`;
later same-role, exactly equal messages become `message_repeat` rows pointing directly to that
original. Each occurrence keeps its chronological position. Equality covers the entire projected
message, not a hash, prefix, keywords or an extracted goal. References are used only when their
exact serialized byte cost is smaller. Assistant/tool evidence is not reference-encoded. Native
caller-authored references are unsupported; extra caller anchor fields never enter the closed
projection. The fixed Choice question explains this representation, including that repetition is
not proof of compliance or success. There is no cross-request dictionary or persistent schema.
If the reference-compressed representation fits, every reference still points to its retained
same-role original and the history remains complete. If references still do not fit, sampling
restarts from the original whole-message projection; `message_repeat` is not carried into sampled
history, so a protected omission never depends on an omitted reference source. A fully represented reference-compressed history
is reported as `referenced`, not `full`; until independent credentialed evidence establishes that
the evaluator interprets the custom reference schema reliably, a lower Jev choice is retained
diagnostically but vetoed with `referenced_downshift_veto`. Equal/higher choices remain usable.
Distinct oversized mandatory anchors still fail closed.
Long histories always retain the top-level `source_instructions` field whole. Historical
user/developer/system messages are request-level state, not aliases for that field and not assumed
to share one scope. When all such protected messages cannot fit, sampling retains the latest message
of each protected role as a recency anchor without claiming it supersedes older text, plus the latest
semantic unit and up to two most recent explicitly failed execution groups. Older protected messages
may be omitted only as whole unit-boundary messages. Their chronological omission marker carries
only item bounds and content-free `omitted_protected_messages` /
`omitted_protected_bytes` counts and says their instructions, constraints, contents and scope are
unknown. No prefix, suffix, hash, summary or semantic extraction of omitted protected text is sent.
Failure evidence is only `status: "failed"` on a projected function/custom-tool
result, never words in output or a status on another item. Existing call-ID/type intervals include
interleaved parallel calls; several failed results in one merged group count once. Unmatched results
remain unmatched, without invented calls. A directly following public assistant message has priority
over optional history when its whole unit fits after all mandatory anchors; adjacency does not prove
a correction succeeded, and no search crosses intervening items. Oversized optional explanations are
omitted whole. Failure anchors plus mandatory text/markers that exceed the existing limits skip with
`context_budget` and `required_state` or `required_items`, never drop an anchor to admit evaluation.
Remaining capacity uses approximately 20% for the beginning and the rest for the recent tail, at
whole-unit boundaries without splitting known call/result intervals. A beginning unit may cross the
20% target once because text is never sliced. Recent tail selection stops at the first whole unit
that no longer fits rather than cherry-picking older smaller evidence past it. Required recency,
failure and semantic units take precedence over that proportion.
Every excluded span has chronological item bounds and an explicit unknown-outcome marker, not a
summary or evidence of tool success. Protected context that cannot fit retains `context_budget`.
The evaluator receives at most 96 KiB serialized state, including `requested_baseline`, and 256 rows
including omission markers. The complete permitted projection is tried before sampling; larger size
alone does not make it sampled. Tool text/identifiers retain 4 KiB/256-byte limits. Structured-tool
inspection independently retains its original 65,536 UTF-16-code-unit cutoff and depth/node rules;
the larger transmission cap makes no previously uninspectable tool payload public. Before selection, the complete supplied
public input is classified within 4,096 items and a 4 MiB text/projected-work bound. Exceeding these
local inspection bounds skips, never selects unchecked history. Ancestry uses the same item-scan
bound without relaxing its control/opaque predicates. Full native forwarding/history is untouched.

Every defined top-level `prompt` is opaque to this consumer and produces `opaque_ancestry`; it is
not fetched or reconstructed. `src/responses/state/public-context-proof.ts` carries negative proof
through ordinary-parent descendants without changing snapshot/spill/history schemas. Reloaded or
spilled ancestors have no positive in-process proof and continue natively without adaptive effort.

`src/responses/tool-groups.ts` provides the pure shared Lite-envelope predicate: exact
`additional_tools`/`developer`, array `tools`, optional absent/null/string `id`, no extra envelope
fields. Both admission gates use it. Declaration children are neither traversed nor disclosed;
only a fixed labelled omission occupies the original chronological position. Repeated envelopes
are allowed within existing bounds and cannot manufacture a user goal. Separate developer/user
messages retain instructions and constraints. The general collector and native declarations are
unchanged. A subsequent native configuration update still makes the history ineligible.

`astra-jev-client.ts` sends one fixed TypeSafe HTTPS systemone request using `jev-latest` and an
effort Choice over the actual native ladder. Its original English rubric weighs goals, failures,
corrective work, ambiguity, consequences and simple tasks; source content is not evaluator
instructions. Model/type/choice and probability/confidence shapes are validated. Probability mass
must total one and the named choice must attain the maximum, each with absolute tolerance `1e-6`.
Ties and valid low-confidence choices are accepted; malformed distributions are not renormalized
and confidence is not a correctness threshold. Request/response bounds are 112/16 KiB, with one
2.5-second fetch/body deadline, manual redirects and no evaluator retry. Failures preserve native
baseline; caller cancellation is terminal and prevents delayed inference dispatch.

The client rechecks exact serialized state and whole-request bytes, including baseline, question,
criteria and escaping. For a state above the former 64 KiB ceiling or request above 80 KiB, a valid
Choice additionally requires a versioned Jev model and a nonnegative safe-integer `usage.input_tokens`
at most 30,000. Missing/malformed usage yields `invalid_usage`; higher reported input yields
`provider_token_budget`. Invalid model/Choice, upstream rejection and timeout retain their existing
failure paths. Smaller requests retain existing Choice behavior without a new usage prerequisite.
This is one bounded API admission attempt, not preflight token counting. TypeSafe documents 32k tokens
for state plus the longest question, separately from its 64k whole-request bound. The 30,000 target
is local operating margin. Usage is post-response evidence and cannot prove no silent upstream
truncation; a compatible tokenizer or explicit provider contract remains needed for that claim.
No retry with reduced instructions, automatic cap increase or additional evaluator question occurs.

The existing live Logs ring/API exposes only the closed `astraJev` diagnostic: selected alias,
requested baseline, evaluator choice, final constrained effort, status/reason and evaluation
latency. Flat optional measurements are `protectedBytes`, `stateBytes`, `requestBytes`, `omittedItems`,
`omittedProtectedMessages`, `omittedProtectedBytes`,
`selectionMode`, `budgetOwner`, `providerInputTokens`, `evaluatorModel`, `repeatedMessages`,
`withheldMediaItems` and `preprocessingMs`. The
protected-byte count serializes only whole source/user/system/developer text with its wrappers and
baseline before reference encoding; state/request sizes are the actual attempted envelopes, not token estimates.
`repeatedMessages` counts exact repeated occurrences represented by references, not omitted text;
`omittedProtectedMessages` / `omittedProtectedBytes` count whole historical
user/system/developer messages omitted by sampled selection and their serialized projected bytes;
`withheldMediaItems` counts historical non-text parts replaced by fixed unknown-content markers.
Null denotes unobserved; selection mode is full, referenced, withheld, sampled or unavailable. Budget owners distinguish inspection,
required-state/items, client state/request and provider-token rejection. The logging boundary allows
only bounded versioned model IDs, finite nonnegative numbers and closed enums. No context, tool body,
key or evaluator error text is logged. Preprocessing measures projection plus client serialization;
the 2.5-second timer starts after serialization, while `evaluationMs` covers the client call and thus
overlaps its serialization measurement. Synchronous projection is bounded, not interruptible by that timer. The diagnostic is not
persisted in usage/history and disappears on eviction/restart. The native effort picker is not
an override indicator. `tests/responses/astra-jev-context.test.ts`,
`tests/responses/astra-jev-client.test.ts`, `tests/responses/astra-jev-repeated-context.test.ts`
and `tests/responses/responses-astra-jev.test.ts`
establish mechanism with mocked upstreams, not real judgment quality or native acceptance.

New whole-history selection carries internal `sampled` provenance outside evaluator state; caller
fields, omission words and pre-existing privacy/tool clipping cannot set it. A sampled choice below
the requested baseline is retained as `evaluatorChoice` but vetoed with `skipped/sampled_downshift_veto`.
An absent explicit baseline remains unchanged with `sampled_baseline_unknown`; no native default is
guessed. Historical-media provenance follows the same conservative rule with
`withheld_media_downshift_veto` / `withheld_media_baseline_unknown`, independently of sampling.
Protected-text sampling is intentionally upshift-only for the same reason: omission markers prove
that potentially governing text is missing but cannot prove what it said. Equal/higher choices may
still apply; the full native execution request remains unchanged except for the final authorized
effort override.
Reference-compressed, otherwise complete projections use
`referenced_downshift_veto` / `referenced_baseline_unknown`; a real Jev API acceptance or choice
alone is not treated as proof that every reference was semantically replayed.
The comparison reuses native effort ordering after Ultra-to-Max inference normalization.
Equal/higher sampled choices and all existing full-projection choices retain ordinary handling.
The cached decision includes any veto, so retries do not reevaluate. Native pins/caps still apply
afterwards and may lower final effort independently; a veto never overrides their authority.
