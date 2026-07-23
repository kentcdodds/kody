export type McpAgentSession = {
	doId: string
}

export async function registerMcpAgentSession(input: {
	db: D1Database
	userId: string
	doId: string
}) {
	await input.db
		.prepare(
			`INSERT INTO mcp_agent_sessions (do_id, user_id)
			VALUES (?, ?)
			ON CONFLICT(do_id) DO NOTHING`,
		)
		.bind(input.doId, input.userId)
		.run()
	const owner = await input.db
		.prepare(`SELECT user_id FROM mcp_agent_sessions WHERE do_id = ?`)
		.bind(input.doId)
		.first<{ user_id: string }>()
	if (owner?.user_id !== input.userId) {
		throw new Error('MCP agent session Durable Object ownership conflict.')
	}
}

export async function listMcpAgentSessionsForUser(
	db: D1Database,
	userId: string,
) {
	const rows = await db
		.prepare(
			`SELECT do_id FROM mcp_agent_sessions
			WHERE user_id = ?
			ORDER BY do_id`,
		)
		.bind(userId)
		.all<{ do_id: string }>()
	return (rows.results ?? []).map((row) => ({ doId: row.do_id }))
}
