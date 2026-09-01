# control-kody

Cloud Agents verify Kody with one CLI and a Feature Map instead of throwaway
scripts. The CLI wraps `dev:ensure`, seed login, authenticated HTTP, PR preview
smoke, `/health` SHA checks, and the Feature Map.

```bash
npm run control-kody -- doctor
npm run control-kody -- dev
npm run control-kody -- login
npm run control-kody -- request GET /account/waiting.json
npm run control-kody -- map waiting
npm run control-kody -- health --sha <commit>
npm run control-kody -- preview -- --pr 42 --check /account/waiting
```

Same entry: `node tools/control-kody.ts`.

## Feature Map

[`.agents/skills/control-kody/references/features/`](../../.agents/skills/control-kody/references/features/README.md)
is the human index.
[`tools/control-kody/feature-catalog.ts`](../../tools/control-kody/feature-catalog.ts)
is the catalog `map --check` and `tools/control-kody.node.test.ts` enforce
against
[`packages/worker/universal/routes.ts`](../../packages/worker/universal/routes.ts).

When you add, remove, or rename a user-facing HTML route under `/account`,
`/admin`, `/login`, `/onboarding`, `/community`, or `/@`, update the catalog and
the matching feature file in the same change.

## Seed login

`login` and `request` pick credentials from the origin host:

- `localhost` / `127.0.0.1` → `jane@example.com` / `ilikecode`
- anything else (PR preview, production) → `me@kentcdodds.com` / `ilikecode`

Override with `--email` / `--password`. `--cookie-file` defaults to
`.tmp/control-kody-cookie`. `preview` uses
[`preview-manual-test`](./preview-manual-testing.md) and its own seed.

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
