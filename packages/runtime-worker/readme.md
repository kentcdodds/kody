# kody runtime worker

The package runtime lane extracted from the main `kody` Worker per
[ADR 0016](../../docs/contributing/decisions/0016-mono-worker-extraction.md):
the package-app origin (`PACKAGE_APP_BASE_URL`), inline package-app serving, the
package invocation API, dynamic callable workflows, and the runtime Durable
Objects (`StorageRunner`, `RunLog`, `PackageRealtimeSession`,
`PackageServiceInstance`).

The Worker entry module is
[`packages/worker/src/runtime-worker.ts`](../worker/src/runtime-worker.ts): the
runtime lane shares the main Worker's source tree, import maps, and pre-bundled
`src/generated/` modules, so this package holds only the deploy configuration.
The entry module is typechecked and tested through the `worker` Nx project.

- `wrangler.jsonc` — the committed base config (script name `kody-runtime`).
  Deployable configs are generated from it plus the main Worker's generated
  config by
  [`tools/ci/runtime-worker-config.ts`](../../tools/ci/runtime-worker-config.ts).
- Build check: `npm run runtime:build` (part of `npm run validate`).
- Deploys/previews: see `.github/workflows/deploy.yml` and `preview.yml`.
- Production Durable Object storage transfer: see the
  [migration runbook](../../docs/contributing/architecture/runtime-worker-migration-runbook.md).
