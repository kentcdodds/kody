# Medium risk (extends)

Open this file when the highest classification is `extends` (medium).

The diff changes a primitive's behavior, shape, or contract and does not add a
primitive. If a primitive is new, stop and open [high.md](./high.md) only.

## Recap

- Summary and classification use `extends` and medium risk. The template is in
  [block-format.md](./block-format.md). Read that file once while authoring.
- Impact cells say `extends` and name the contract change (column, route, guard,
  capability, or similar).
- Update `primitives.yaml` when this change removes a primitive or materially
  reshapes its meaning or ownership roots. Otherwise leave the map unchanged.
  Follow source-of-truth rule 3 in [SKILL.md](../SKILL.md), and run
  `npm run primitives:check` after map edits.
- Call out an invariant from `primitives.yaml` when the diff touches one.

## Preview

Also load [preview-manual-test](../../preview-manual-test/SKILL.md) and exercise
the PR preview as the seeded logged-in user with data for this change
(`control-kody request` / `--request`, then a UI pass). A health/login smoke
alone is not enough. Do not cat the session cookie into curl or Python.
