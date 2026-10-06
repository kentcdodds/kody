# Low risk (composes)

Open this file when the rollup is `composes` (low). Leave
[medium.md](./medium.md) and [high.md](./high.md) unread.

Wiring and call sites only. No primitive's behavior, shape, or contract changes,
and this PR does not add a primitive.

## Recap

- Summary and classification use `composes` and low risk. The template is in
  [block-format.md](./block-format.md). Read that file once while authoring.
- Impact cells say `composes`.
- Do not edit `primitives.yaml` for ordinary feature work.
- Call out an invariant from `primitives.yaml` when the diff touches one (for
  example per-user isolation), even at low risk.
- A plan that requires no change to any primitive is the lowest-risk outcome.
  Say that in one line under Primitives touched.
- A low-risk recap does not require a preview pass.

If any touched primitive is `extends` or `adds`, stop and open that risk file
instead of this one.
