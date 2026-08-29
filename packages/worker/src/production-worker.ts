import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import { JobsHost } from './jobs/jobs-host.ts'
import { originWorkerHandler } from './origin-handler.ts'

/**
 * Production origin Worker entrypoint (script `kody-production`). Reached
 * only through the deploy-generated Wrangler config's top-level `main`
 * override (`tools/ci/production-resources.ts`'s
 * `writeGeneratedWranglerConfig()`) — the committed
 * `packages/worker/wrangler.jsonc` never points `env.production` at this
 * file directly, so local `CLOUDFLARE_ENV=production` keeps resolving
 * `index.ts` instead.
 *
 * ADR 0034: origin owns zero Durable Object classes in production. Every
 * env.production `durable_objects` binding sets `script_name` (kody-platform
 * or kody-runtime) and the `workflows` binding does too, so none of those
 * classes need a local export here — only `index.ts` (dev/test/preview)
 * does, because env.test has no separate platform/runtime scripts to bind
 * cross-script, and env.preview's bootstrap deploy briefly owns them before
 * the platform/runtime hand-off. See
 * docs/contributing/architecture/platform-worker-migration-runbook.md and
 * the runtime-worker counterpart.
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
 * DynamicCallableWorkflow, PackageAppRuntimeBridge) is reached in production
 * only through cross-script bindings or the `RUNTIME_WORKER` service
 * forward, never through a local export on this script.
 */
export { KodyFetchGateway, JobsHost }

export default originWorkerHandler
