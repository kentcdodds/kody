export async function getMcpUserServerInstructions(
	db: D1Database,
	userId: string,
): Promise<string | null> {
	const row = await db
		.prepare(
			'SELECT instructions FROM mcp_user_server_instructions WHERE user_id = ? LIMIT 1',
		)
		.bind(userId)
		.first<{ instructions: string }>()
	return row?.instructions ?? null
}

export async function saveMcpUserServerInstructions(
	db: D1Database,
	userId: string,
	instructions: string,
): Promise<void> {
	const trimmed = instructions.trim()
	if (trimmed === '') {
		await db
			.prepare('DELETE FROM mcp_user_server_instructions WHERE user_id = ?')
			.bind(userId)
			.run()
		return
	}
	await db
		.prepare(
			`INSERT INTO mcp_user_server_instructions (user_id, instructions, updated_at)
			VALUES (?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(user_id) DO UPDATE SET
				instructions = excluded.instructions,
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(userId, trimmed)
		.run()
}
