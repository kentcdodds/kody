# High risk (adds)

Open this file when the rollup is `adds` (high). Leave [low.md](./low.md) and
[medium.md](./medium.md) unread.

This PR introduces a new primitive. `adds` outranks `extends` and `composes`.

## Recap and the map

- Summary and classification use `adds` and high risk. The template is in
  [block-format.md](./block-format.md). Read that file once while authoring.
- Update `primitives.yaml` in this PR (new `id`, or a removed primitive, or a
  renamed meaning, or ownership roots that must change). Do not edit `summary`
  for ordinary feature work. Put behavioral detail in the architecture docs
  linked under `docs:`. Run `npm run primitives:check` after map edits.
- Impact cells for the new primitive say `adds`. Other touched primitives can
  still be `extends` or `composes`. The summary stays on the rollup (`adds`,
  high).
- Call out an invariant from `primitives.yaml` when the diff touches one.

## Preview

Also load [preview-manual-test](../../preview-manual-test/SKILL.md) and exercise
the PR preview as the seeded logged-in user with data for this change
(`control-kody request` / `--request`, then a UI pass). A health/login smoke
alone is not enough. Do not cat the session cookie into curl or Python.
