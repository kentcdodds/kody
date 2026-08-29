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
 * Production uses the slimmer `production-worker.ts` entry from a
 * deploy-generated Wrangler config (`tools/ci/production-resources.ts`)
 * only when the origin script is already in steady state (platform/runtime
 * own the transferred classes). A fresh production script still deploys
 * this full entry first so `new_sqlite_classes` can replay. See
 * `tools/ci/origin-production-deploy-state.ts`.
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
