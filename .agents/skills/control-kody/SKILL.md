---
name: control-kody
description: >
  Drive and verify the Kody app with a Feature Map and one CLI. Use when
  changing UI, account routes, preview deploys, or proving a Cloud Agent change
  with a real origin, session, and /health SHA.
---

# control-kody

Do not invent a throwaway curl script, scrape PR comments by hand, or rediscover
account routes from `routes.ts`. Use the CLI and the Feature Map.

```bash
node tools/control-kody.ts doctor
node tools/control-kody.ts dev
node tools/control-kody.ts login
node tools/control-kody.ts request GET /account/waiting.json
node tools/control-kody.ts request GET /account/waiting --dump --contains 'Waiting'
node tools/control-kody.ts map waiting
node tools/control-kody.ts map --check
node tools/control-kody.ts health --sha <merge-sha>
node tools/control-kody.ts preview --pr 42 --request 'GET /account/waiting.json' --check /account/waiting
node tools/control-kody.ts package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead]
node tools/control-kody.ts execute --origin <preview> --code-file fixture.ts [--params-file params.json]
node tools/control-kody.ts search --origin <preview> --query "packageSave" [--domain packages]
```

`--kody-id` is an alias for `--package-name`.
`npm run control-kody -- <command>` is the same entry.

After `login`, keep using `request` for HTML and JSON assertions. Do **not**
`cat` the session cookie into `curl` or Python. `--dump` writes the raw body to
`.tmp/control-kody-body`. `--contains <text>` fails unless that substring is in
the body. Cookie files are bound to the origin that created them; `request`
fetches GET/HEAD first and only POSTs `/auth` when the response is HTTP 401 or
login HTML. Public pages such as `/pricing` do not need a session. Mutating
methods log in first when no cookie exists.

`preview` forwards `--pr`, `--request`, and `--check` to `preview:manual-test`.
A `--` separator is optional.

`doctor` (and a failed local `login`) print `npm run migrate:local` plus
`node tools/seed-test-data.ts --local` when local APP_DB was never migrated or
seeded.

## Feature Map

[references/features/README.md](./references/features/README.md) is the
human-readable index. `tools/control-kody/feature-catalog.ts` is the
machine-readable source. `map --check` (and its node test) fail when a listed
path leaves `routes.ts` or a required HTML route has no entry.

Load **one** feature file for the surface you are changing. Run `map --check`
before opening a Feature Map PR.

## Seed users

- Local: `jane@example.com` / `ilikecode` (non-admin)
- Preview: `me@kentcdodds.com` / `ilikecode` (non-admin, empty until you create
  data through JSON APIs, or `package-create` for a saved package)
- `/admin` 403 and `/mcp` 401 are expected for those seeds
- Admin-gated states cannot be preview-tested with the public seed; use the
  local admin account plus Workers or unit tests
- `execute` / `search` reuse the same seed session on preview or local; they
  refuse `https://kody.codes`

## Proof

CI green is not enough for a user-visible account change. Prefer:

1. `doctor` then `dev` or `preview`
2. `request` (`--dump` / `--contains`) or `--check` as the seed user **with data
   for this change**
3. A computerUse video or screenshot of the same page
4. After merge, `health --origin https://kody.codes --sha <merge>` (full SHA,
   unique short SHA, or a later descendant HEAD that contains the merge)

See
[docs/contributing/control-kody.md](../../../docs/contributing/control-kody.md)
and [preview-manual-test](../preview-manual-test/SKILL.md).
