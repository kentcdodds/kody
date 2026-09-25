# control-kody

Cloud Agents verify Kody with one CLI and a Feature Map instead of throwaway
scripts. The CLI wraps `dev:ensure`, seed login, authenticated HTTP, PR preview
smoke, `/health` SHA checks, and the Feature Map.

```bash
npm run control-kody -- doctor
npm run control-kody -- dev
npm run control-kody -- login
npm run control-kody -- request GET /account/waiting.json
npm run control-kody -- request GET /account/waiting --dump --contains 'Waiting'
npm run control-kody -- map waiting
npm run control-kody -- map --check
npm run control-kody -- health --sha <commit>
npm run control-kody -- preview --pr 42 --check /account/waiting
npm run control-kody -- package-create --origin <preview> --package-name <leaf-or-@scope/leaf> [--head-ahead]
npm run control-kody -- execute --origin <preview> --code-file fixture.ts [--params-file params.json]
npm run control-kody -- search --origin <preview> --query "packageSave" [--domain packages]
```

Same entry: `node tools/control-kody.ts`.

`doctor` checks Node 26, the Playwright browser revision in
`node_modules/playwright-core/browsers.json`, git `core.hooksPath`, origin
`/health`, and local APP_DB. Playwright passes only when `chromium-<rev>` and
`chromium_headless_shell-<rev>` each contain `INSTALLATION_COMPLETE`. A missing
revision fails with the unzip steps in
[Cursor Cloud Agent notes](./cloud-agents.md).

`health --sha` succeeds when `/health` `commitSha` equals the argument, uniquely
starts with it (git short SHA, 7+ characters), or is a descendant that contains
it (`git merge-base --is-ancestor`). A later main HEAD deploy still counts as
the merge being live.

## Feature Map

[`.agents/skills/control-kody/references/features/`](../../.agents/skills/control-kody/references/features/README.md)
is the human index.
[`tools/control-kody/feature-catalog.ts`](../../tools/control-kody/feature-catalog.ts)
is the catalog `map --check` and `tools/control-kody.node.test.ts` enforce
against
[`packages/worker/universal/routes.ts`](../../packages/worker/universal/routes.ts).

When you add, remove, or rename a user-facing HTML route under `/account`,
`/admin`, `/login`, `/onboarding`, `/community`, or `/@`, update the catalog and
the matching feature file in the same change. Run `map --check` before opening a
Feature Map PR.

After `login`, keep using `request` for HTML and JSON assertions. Do not `cat`
the session cookie into `curl` or Python. `request --dump` writes the raw body
to `.tmp/control-kody-body`. `request --contains <text>` fails unless that
substring is in the body. `request` fetches GET/HEAD first and only POSTs
`/auth` when the response is HTTP 401 or login HTML, so public pages such as
`/pricing` do not need a session. Mutating methods log in first when no cookie
exists.

`preview` forwards its flags to `preview:manual-test`. `--pr`, `--request`, and
`--check` work without a `--` separator.

`doctor` checks local APP_DB readiness. A failed local `login` (unmigrated or
unseeded D1) prints:

```bash
npm run migrate:local
node tools/seed-test-data.ts --local
```

## Seed login

`login` and `request` pick credentials from the origin host:

- `localhost` / `127.0.0.1` → `jane@example.com` / `ilikecode`
- anything else (PR preview, production) → `me@kentcdodds.com` / `ilikecode`

Override with `--email` / `--password`. `--cookie-file` defaults to
`.tmp/control-kody-cookie` and stores the origin that created the session, so a
leftover local cookie is not sent to a preview. `preview` uses
[`preview-manual-test`](./preview-manual-testing.md) and its own seed.

`package-create` registers a stub saved package on a PR preview (or local
origin) through MCP `packageGetGitRemote({ create: true, kody_id })`. Pass the
package name leaf or `@owner/leaf` with `--package-name`. It reuses `--origin`,
`--email`, `--password`, `--cookie-file`, and `--json`. Pass
`--package-name <leaf-or-@scope/leaf>` (required; `--kody-id` is an alias),
`--description` (optional), and `--head-ahead` to push one unpublished commit so
the package page can show **HEAD ahead of published**. Do not POST a create
action to `/account/packages.json` — that endpoint has no package-create action.
Logged-in preview testing does not require agents to hand-roll an MCP OAuth
dance — the CLI does it for them. The command refuses `https://kody.codes`.

`execute` and `search` use the same OAuth client against a preview or local
origin. `execute` reads an ESM module from `--code-file` (default export) and
optional JSON `--params-file`. `search` takes `--query`, and optionally
`--domain`, `--entity`, and `--limit`. Both refuse `https://kody.codes`. Do not
hand-write a throwaway MCP client script for preview fixtures.

## Daily garden

`@kentcdodds/verification-skill-maintain` runs every day at 06:00
America/Denver. It scans the Feature Map on `kentcdodds/kody` `main` and spawns
one Cursor Cloud Agent when the catalog is stale or a required route is
unmapped. The agent updates the map, follows
[`ship-pr`](../../.agents/skills/ship-pr/SKILL.md) for low or medium risk, and
records an outcome. Pause with
`kody:@kentcdodds/verification-skill-maintain/pause`.

This is the same shape as the [friction log](./friction-log.md) and e2e flake
hunter packages: a Kody job, not a GitHub cron.

## Related

- [control-kody skill](../../.agents/skills/control-kody/SKILL.md)
- [Manual preview testing](./preview-manual-testing.md)
- [Cursor Cloud Agent notes](./cloud-agents.md)
