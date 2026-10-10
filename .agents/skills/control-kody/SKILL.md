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
npm run control-kody -- doctor
npm run control-kody -- dev
npm run control-kody -- login
npm run control-kody -- request GET /account/waiting.json
npm run control-kody -- request GET /@user-me/-/waiting --dump --contains 'Waiting'
npm run control-kody -- request POST /account/organizations/new --form slug=x-org --form displayName=X
npm run control-kody -- request POST /account/profile/avatar.json --multipart --form avatar=@./avatar.png
npm run control-kody -- preview --pr 42 --request 'POST /account/organizations/new 302 --form slug=x-org --form displayName=X --contains /@x-org'
npm run control-kody -- map waiting
npm run control-kody -- map --check
npm run control-kody -- health --sha <merge-sha>
npm run control-kody -- preview --pr 42 --request 'GET /account/waiting.json' --check /account/waiting
npm run control-kody -- browse --origin <preview> --path /@user-me/pkg [--record]
npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead]
npm run control-kody -- execute --origin <preview> --code-file fixture.ts [--params-file params.json]
npm run control-kody -- search --origin <preview> --query "packageSave" [--domain packages]
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
A `--` separator is optional. `--request` specs take trailing `--dump` /
`--contains <text>` like `request`:
`preview --pr 42 --request 'GET /pricing --dump --contains Worker compute'`.

JSON is the default body. Repeat `--form name=value` for
`application/x-www-form-urlencoded`. Add `--multipart` for
`multipart/form-data`; a value that starts with `@` is a file path. Create
organization is form-only (`request.formData()`), so script it as:

```bash
npm run control-kody -- preview --pr 42 --request 'POST /account/organizations/new 302 --form slug=x-org --form displayName=X --contains /@x-org'
```

`preview --request` does not follow redirects. `--contains` also searches the
`Location` header, which is `/@x-org` after a successful create and the error
URL when the form is rejected. Avatar upload is the multipart route:

```bash
npm run control-kody -- request POST /account/profile/avatar.json --multipart --form avatar=@./avatar.png
```

`browse` reuses the seed cookie from `.tmp/control-kody-cookie` (after `login`
or `preview`) and injects it into headed Playwright Chromium the same way E2E
does (`addCookies`). Opens `--path` already signed in. Optional `--record`
writes video under `.tmp/control-kody-browse`. Prefer MCP/API/`execute` for
proof; use `browse` only when UI is under test. Cursor `computerUse` drives its
own browser and cannot attach to the CLI Chromium window — for computerUse, open
`/login?redirectTo=<path>` with the public seed credentials instead.

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
  data through JSON APIs, or `package-create` for a saved package). Experimenter
  flags stay off unless the PR is labeled `preview-flag:<key>` for a key in
  `tools/preview-seed-flag-allowlist.ts`. Example: label
  `preview-flag:connection-profiles`, wait for 🔎 Preview, then
  `npm run control-kody -- request GET /account/connected-agents.json --origin <preview> --dump --contains '"connectionProfilesEnabled":true'`.
- `/admin` 403 and `/mcp` 401 are expected for those seeds
- Admin-gated states cannot be preview-tested with the public seed; use the
  local admin account plus Workers or unit tests
- `execute` / `search` reuse the same seed session on preview or local; they
  refuse `https://kody.codes`
- `packageSave`, publish, and `packageGetGitRemote` / `package-create` need the
  remote `ARTIFACTS` binding. Use a PR preview origin, not `npm run dev`. See
  [Local limitations](../../../docs/contributing/cloud-agents.md#local-limitations).

## Proof

CI green is not enough for a user-visible account change. Prefer:

1. `doctor` then `dev` or `preview`
2. `request` (`--dump` / `--contains`) or `--check` as the seed user **with data
   for this change**
3. When UI is under test: `browse --origin <origin> --path <path>` (or
   computerUse with `/login?redirectTo=<path>` and the public seed credentials).
   Prefer MCP/API otherwise.
4. After merge, `health --origin https://kody.codes --sha <merge>` (full SHA,
   unique short SHA, or a later descendant HEAD that contains the merge)

See
[docs/contributing/control-kody.md](../../../docs/contributing/control-kody.md)
and [preview-manual-test](../preview-manual-test/SKILL.md).
