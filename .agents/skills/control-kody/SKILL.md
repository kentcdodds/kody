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
node tools/control-kody.ts map waiting
node tools/control-kody.ts health --sha <merge-sha>
node tools/control-kody.ts preview -- --request 'GET /account/waiting.json' --check /account/waiting
```

`npm run control-kody -- <command>` is the same entry.

## Feature Map

[references/features/README.md](./references/features/README.md) is the
human-readable index. `tools/control-kody/feature-catalog.ts` is the
machine-readable source. `map --check` (and its node test) fail when a listed
path leaves `routes.ts` or a required HTML route has no entry.

Load **one** feature file for the surface you are changing.

## Seed users

- Local: `jane@example.com` / `ilikecode` (non-admin)
- Preview: `me@kentcdodds.com` / `ilikecode` (non-admin, empty until you create
  data through JSON APIs)
- `/admin` 403 and `/mcp` 401 are expected for those seeds

## Proof

CI green is not enough for a user-visible account change. Prefer:

1. `doctor` then `dev` or `preview`
2. `request` / `--check` as the seed user **with data for this change**
3. A computerUse video or screenshot of the same page
4. After merge, `health --origin https://kody.codes --sha <merge>`

See
[docs/contributing/control-kody.md](../../../docs/contributing/control-kody.md)
and [preview-manual-test](../preview-manual-test/SKILL.md).
