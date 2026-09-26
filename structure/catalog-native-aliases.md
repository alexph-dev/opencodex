# Native Catalog Aliases and Reviewers

## Additive native model aliases

`src/codex/catalog/native-model-aliases.ts` projects an explicitly configured canonical OpenAI
forward alias as a second selector, never a takeover of the ordinary native model. Admission
captures the alias before asynchronous discovery. Known model IDs, duplicate aliases and complete
selectors owned by configured combos are excluded, including combos omitted from the catalog for
incomplete or incompatible capabilities. Existing routing precedence is unchanged.

The builder derives the alias from actual native metadata. Merge rebases fresh aliases from the
normalized native row, retaining instructions, model messages, tools, context limits, reasoning
ladder and native support metadata. Only selection/presentation and provenance fields differ.
The shared auto-review finalizer excludes fresh and retained aliases from legacy-root inference,
then copies effective reviewer metadata and detached provenance from the finalized native source.
A valid same-source alias is not a competing model for alias-keyed reviewer propagation; genuine
competing rows, different sources and invalid provenance retain the collision guard.

Alias publication is additive: ordinary entries/defaults and retained foreign rows are preserved,
removal deletes generated aliases, and unfeatured aliases follow ordinary entries in picker order.
The existing alias CLI performs guarded catalog convergence; a saved setting alone does not prove
publication. `tests/codex-integration/native-model-alias.test.ts` and
`tests/responses/responses-native-model-alias.test.ts` cover catalog/finalization, collisions and
native HTTP/WebSocket/compact paths. The separate opt-in
[Astra-Jev request policy](transports/astra-jev.md#adaptive-astra-jev-effort) changes no catalog capacity.

## Provider-scoped approval reviewer

`src/codex/catalog/auto-review.ts` resolves exact case-preserving provider/model reviewer selectors against the final catalog in both retained sync and `src/codex/convergence.ts`. Valid per-model selection wins over valid provider-wide selection, then the root selector supplies fallback. Native root stamps retain the observed original value and applied selector bound to their slug; removal restores the original only while the applied value is unchanged. The native provenance remains after restoration so an equal provider reviewer cannot trigger legacy reclassification on the next sync. Ambiguous legacy unmarked catalogs retain their existing heuristic cleanup. Provider stamps do not change routing or credentials.
