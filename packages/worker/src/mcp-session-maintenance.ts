import { handleSecretMaintenanceRequest } from './maintenance-handler.ts'
import { backfillMcpAgentSessions } from './mcp/session-backfill.ts'
import {
	markMcpAgentSessionBackfillComplete,
	requiredMcpAgentSessionBackfillVersion,
} from './mcp/session-backfill-marker.ts'

async function readJson(request: Request) {
	const value: unknown = await request.json()
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Maintenance request body must be an object.')
	}
	return value as Record<string, unknown>
}

export async function handleMcpAgentSessionBackfillRequest(
	request: Request,
	env: Env,
) {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'MCP agent session backfill is not configured.',
		async run() {
			const body = await readJson(request)
			const doIds = Array.isArray(body['doIds'])
				? body['doIds'].filter(
						(value): value is string =>
							typeof value === 'string' && value.length > 0,
					)
				: []
			if (doIds.length === 0 || doIds.length > 100) {
				throw new Error('doIds must contain between 1 and 100 object ids.')
			}
			const dryRun = body['dryRun'] !== false
			const result = await backfillMcpAgentSessions({ env, doIds, dryRun })
			return {
				dryRun,
				scanned: doIds.length,
				rows: result.rows,
				failures: result.failures,
			}
		},
	})
}

export async function handleMcpAgentSessionBackfillCompleteRequest(
	request: Request,
	env: Env,
) {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'MCP agent session backfill is not configured.',
		async run() {
			const body = await readJson(request)
			const auditSummary = body['auditSummary']
			if (
				!auditSummary ||
				typeof auditSummary !== 'object' ||
				Array.isArray(auditSummary)
			) {
				throw new Error('auditSummary is required.')
			}
			const summary = auditSummary as Record<string, unknown>
			if (
				Number(summary['failed'] ?? 0) !== 0 ||
				Number(summary['conflicts'] ?? 0) !== 0 ||
				Number(summary['noOwner'] ?? 0) !== 0
			) {
				throw new Error(
					'Backfill cannot complete with failures, ownership conflicts, or unproven ownerless objects.',
				)
			}
			const completedAt = new Date().toISOString()
			await markMcpAgentSessionBackfillComplete({
				db: env.APP_DB,
				auditSummaryJson: JSON.stringify(summary),
				completedAt,
			})
			return {
				key: 'mcp_agent_sessions',
				version: requiredMcpAgentSessionBackfillVersion,
				completedAt,
			}
		},
	})
}
