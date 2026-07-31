import { parseMcpCallerContext, type McpServerProps } from './context.ts'

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
	const owned = await input.db
		.prepare(
			`SELECT 1 AS owned FROM mcp_agent_sessions
			WHERE do_id = ? AND user_id = ?`,
		)
		.bind(input.doId, input.userId)
		.first<{ owned: number }>()
	if (owned?.owned !== 1) {
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

export async function readPersistedMcpAgentOwner(input: {
	storage: Pick<DurableObjectStorage, 'get'>
	doId: string
}) {
	const props = await input.storage.get<McpServerProps>('props')
	return {
		doId: input.doId,
		userId: props ? (parseMcpCallerContext(props).user?.userId ?? null) : null,
	}
}

export async function purgePersistedMcpAgentSession(input: {
	storage: Pick<DurableObjectStorage, 'get' | 'deleteAll'>
	doId: string
	userId: string
}) {
	const owner = await readPersistedMcpAgentOwner(input)
	if (owner.userId !== input.userId) {
		throw new Error('MCP agent session user scope mismatch.')
	}
	await input.storage.deleteAll()
}

/** Clears storage only when the DO has no attributable userId. */
export async function purgePersistedOwnerlessMcpAgentSession(input: {
	storage: Pick<DurableObjectStorage, 'get' | 'deleteAll'>
	doId: string
}) {
	const owner = await readPersistedMcpAgentOwner(input)
	if (owner.userId !== null) {
		throw new Error('MCP agent session has an owner; refusing ownerless purge.')
	}
	await input.storage.deleteAll()
}
