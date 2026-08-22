# kody app-surface worker

The Remix/content lane extracted from the main `kody` Worker per
[ADR 0034](../../docs/contributing/decisions/0034-app-worker-content-deploy.md):
browser UI, blog posts, official guides, and static assets. This script owns
**no Durable Object classes**, so a guide, blog, or UI deploy does not reset
MCP or other Durable Objects on the main Worker.

The Worker entry module is
[`packages/worker/src/app-worker.ts`](../worker/src/app-worker.ts): the app
surface shares the main Worker's source tree and import maps, so this package
holds only the deploy configuration.

- `wrangler.jsonc` — the committed base config (script name `kody-app`).
  Deployable configs are generated from it plus the main Worker's generated
  config by
  [`tools/ci/app-worker-config.ts`](../../tools/ci/app-worker-config.ts).
- Build check: `npm run app:build` (part of `npm run validate`).
- Deploys/previews: see `.github/workflows/deploy.yml` and `preview.yml`.
