import { McpClientHub } from './mcp-client/hub.ts'
import { MCP } from './mcp/index.ts'
import { JobsHost } from './jobs/jobs-host.ts'
import { StorageRunner } from './storage-runner.ts'
import { RunLog } from './run-records/run-log-do.ts'
import { UserMeter } from './entitlements/user-meter-do.ts'
import { StripePlanRefresh } from './billing/stripe-plan-refresh-do.ts'
import { Mailbox } from './email/mailbox-do.ts'
import { RepoSession } from './repo/repo-session-do.ts'
import { RepoSessionIndex } from './repo/repo-session-index-do.ts'
import { PackageRealtimeSession } from '#worker/package-runtime/realtime-session.ts'
import { DynamicCallableWorkflow } from '#worker/package-runtime/package-workflows.ts'
import { KodyFetchGateway } from '#mcp/fetch-gateway.ts'
import { PackageAppRuntimeBridge } from '#worker/package-runtime/package-app.ts'
import { OAuthPurgeCoordinator } from './oauth-purge.ts'
import { originWorkerHandler } from './origin-handler.ts'

/**
 * Dev/test/preview origin entry. `env.test` (local dev, workers-unit,
 * Playwright) and `env.preview` both inherit this top-level `main`:
 *
 * - `env.test` has no separate platform/runtime/jobs scripts, so this single
 *   script owns every Durable Object and `ctx.exports` WorkerEntrypoint
 *   locally (no `script_name` on any binding).
 * - `env.preview`'s fresh-per-PR bootstrap deploy briefly owns the
 *   platform/runtime classes too, before the platform and runtime preview
 *   scripts exist to hand them off to (see
 *   docs/contributing/architecture/platform-worker-migration-runbook.md and
 *   the runtime-worker counterpart).
 *
 * Production uses the slimmer `production-worker.ts` entry
 * (`env.production.main`) instead: every env.production
 * `durable_objects`/`workflows` binding sets `script_name`, so origin owns
 * zero Durable Object classes there (ADR 0034) and none of the classes below
 * need to ship in the production bundle.
 */
export {
	RepoSession,
	RepoSessionIndex,
	KodyFetchGateway,
	McpClientHub,
	MCP,
	JobsHost,
	PackageRealtimeSession,
	DynamicCallableWorkflow,
	PackageAppRuntimeBridge,
	StorageRunner,
	RunLog,
	UserMeter,
	StripePlanRefresh,
	Mailbox,
	OAuthPurgeCoordinator,
}

export default originWorkerHandler
