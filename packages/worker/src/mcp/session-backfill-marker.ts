export const mcpAgentSessionBackfillKey = 'mcp_agent_sessions'
export const requiredMcpAgentSessionBackfillVersion = 1

export class McpAgentSessionBackfillIncompleteError extends Error {
	constructor() {
		super(
			'MCP agent session backfill is incomplete; account deletion is temporarily disabled.',
		)
		this.name = 'McpAgentSessionBackfillIncompleteError'
	}
}

export async function assertMcpAgentSessionBackfillComplete(db: D1Database) {
	const row = await db
		.prepare(`SELECT version FROM deployment_backfill_markers WHERE key = ?`)
		.bind(mcpAgentSessionBackfillKey)
		.first<{ version: number }>()
	if (Number(row?.version ?? 0) < requiredMcpAgentSessionBackfillVersion) {
		throw new McpAgentSessionBackfillIncompleteError()
	}
}

export async function markMcpAgentSessionBackfillComplete(input: {
	db: D1Database
	auditSummaryJson: string
	completedAt: string
}) {
	await input.db
		.prepare(
			`INSERT INTO deployment_backfill_markers (
				key, version, completed_at, audit_summary_json
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET
				version = excluded.version,
				completed_at = excluded.completed_at,
				audit_summary_json = excluded.audit_summary_json`,
		)
		.bind(
			mcpAgentSessionBackfillKey,
			requiredMcpAgentSessionBackfillVersion,
			input.completedAt,
			input.auditSummaryJson,
		)
		.run()
}
