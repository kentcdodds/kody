import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import { JobsHost } from './jobs/jobs-host.ts'
import { originWorkerHandler } from './origin-handler.ts'

/**
 * Production origin Worker entrypoint (script `kody-production`).
 *
 * The committed `packages/worker/wrangler.jsonc` never points
 * `env.production.main` here. `tools/ci/production-resources.ts` overrides
 * the generated config's top-level `main` only after
 * `tools/ci/origin-production-deploy-state.ts` classifies the live origin
 * script as steady-state (platform and runtime already own every
 * transferred class). Fresh scripts keep `index.ts` so historical
 * `new_sqlite_classes` can replay. Ambiguous Cloudflare state also keeps
 * `index.ts` (fail closed).
 *
 * ADR 0034: origin owns zero Durable Object classes in production. Every
 * env.production `durable_objects` binding sets `script_name` (kody-platform
 * or kody-runtime) and the `workflows` binding does too, so none of those
 * classes need a local export here — only `index.ts` (dev/test/preview, and
 * fresh/ambiguous production) does.
 *
 * The two exports kept here are `ctx.exports` WorkerEntrypoint contracts
 * production genuinely calls on this script:
 * - `KodyFetchGateway` — the origin-only `/__maintenance/execute-smoke`
 *   deploy check (see `execute-maintenance.ts`) proves this script's own
 *   loopback export. MCP `execute` itself runs on `kody-platform` and looks
 *   up its own gateway there, not through this script.
 * - `JobsHost` — `kody-jobs`' `HOST` service binding calls back into this
 *   script for job execution (see
 *   docs/contributing/architecture/jobs-worker-migration-runbook.md).
 *
 * Everything else `index.ts` exports (MCP, McpClientHub,
 * OAuthPurgeCoordinator, UserMeter, Mailbox, RepoSession, RepoSessionIndex,
 * StripePlanRefresh, StorageRunner, RunLog, PackageRealtimeSession,
 * DynamicCallableWorkflow, PackageAppRuntimeBridge) is reached in
 * steady-state production only through cross-script bindings or the
 * `RUNTIME_WORKER` service forward, never through a local export on this
 * script.
 */
export { KodyFetchGateway, JobsHost }

export default originWorkerHandler
