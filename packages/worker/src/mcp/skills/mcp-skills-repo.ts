import { type McpSkillRow } from './mcp-skills-types.ts'

export function skillVectorId(skillId: string): string {
	return `skill_${skillId}`
}

export async function insertMcpSkill(
	db: D1Database,
	row: Omit<McpSkillRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	},
): Promise<void> {
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO mcp_skills (
				id, user_id, title, description, keywords, code, search_text,
				uses_capabilities, parameters, connection_bindings, template_key,
				inferred_capabilities, inference_partial, read_only, idempotent,
				destructive, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.id,
			row.user_id,
			row.title,
			row.description,
			row.keywords,
			row.code,
			row.search_text ?? null,
			row.uses_capabilities ?? null,
			row.parameters ?? null,
			row.connection_bindings ?? null,
			row.template_key ?? null,
			row.inferred_capabilities,
			row.inference_partial,
			row.read_only,
			row.idempotent,
			row.destructive,
			row.created_at ?? now,
			row.updated_at ?? now,
		)
		.run()
}

export async function getMcpSkillById(
	db: D1Database,
	userId: string,
	skillId: string,
): Promise<McpSkillRow | null> {
	const result = await db
		.prepare(
			`SELECT id, user_id, title, description, keywords, code, search_text,
				uses_capabilities, parameters, connection_bindings, template_key,
				inferred_capabilities, inference_partial, read_only, idempotent,
				destructive, created_at, updated_at
			FROM mcp_skills WHERE id = ? AND user_id = ?`,
		)
		.bind(skillId, userId)
		.first<Record<string, unknown>>()
	if (!result) return null
	return mapRow(result)
}

export async function updateMcpSkill(
	db: D1Database,
	userId: string,
	skillId: string,
	fields: {
		title: string
		description: string
		keywords: string
		code: string
		search_text: string | null
		uses_capabilities: string | null
		parameters: string | null
		connection_bindings: string | null
		inferred_capabilities: string
		template_key: string | null
		inference_partial: 0 | 1
		read_only: 0 | 1
		idempotent: 0 | 1
		destructive: 0 | 1
	},
): Promise<boolean> {
	const now = new Date().toISOString()
	const out = await db
		.prepare(
			`UPDATE mcp_skills SET
				title = ?, description = ?, keywords = ?, code = ?, search_text = ?,
				uses_capabilities = ?, parameters = ?, connection_bindings = ?, template_key = ?,
				inferred_capabilities = ?, inference_partial = ?, read_only = ?, idempotent = ?,
				destructive = ?, updated_at = ?
			WHERE id = ? AND user_id = ?`,
		)
		.bind(
			fields.title,
			fields.description,
			fields.keywords,
			fields.code,
			fields.search_text,
			fields.uses_capabilities,
			fields.parameters,
			fields.connection_bindings,
			fields.template_key,
			fields.inferred_capabilities,
			fields.inference_partial,
			fields.read_only,
			fields.idempotent,
			fields.destructive,
			now,
			skillId,
			userId,
		)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function deleteMcpSkill(
	db: D1Database,
	userId: string,
	skillId: string,
): Promise<boolean> {
	const out = await db
		.prepare(`DELETE FROM mcp_skills WHERE id = ? AND user_id = ?`)
		.bind(skillId, userId)
		.run()
	return (out.meta.changes ?? 0) > 0
}

export async function listMcpSkillsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<McpSkillRow>> {
	const { results } = await db
		.prepare(
			`SELECT id, user_id, title, description, keywords, code, search_text,
				uses_capabilities, parameters, connection_bindings, template_key,
				inferred_capabilities, inference_partial, read_only, idempotent,
				destructive, created_at, updated_at
			FROM mcp_skills WHERE user_id = ?`,
		)
		.bind(userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

/** All rows in `mcp_skills` (for maintenance / Vectorize reindex). */
export async function listAllMcpSkills(
	db: D1Database,
): Promise<Array<McpSkillRow>> {
	const { results } = await db
		.prepare(
			`SELECT id, user_id, title, description, keywords, code, search_text,
				uses_capabilities, parameters, connection_bindings, template_key,
				inferred_capabilities, inference_partial, read_only, idempotent,
				destructive, created_at, updated_at
			FROM mcp_skills`,
		)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapRow)
}

function mapRow(r: Record<string, unknown>): McpSkillRow {
	return {
		id: String(r['id']),
		user_id: String(r['user_id']),
		title: String(r['title']),
		description: String(r['description']),
		keywords: String(r['keywords']),
		code: String(r['code']),
		search_text: r['search_text'] == null ? null : String(r['search_text']),
		uses_capabilities:
			r['uses_capabilities'] == null ? null : String(r['uses_capabilities']),
		parameters: r['parameters'] == null ? null : String(r['parameters']),
		connection_bindings:
			r['connection_bindings'] == null
				? null
				: String(r['connection_bindings']),
		template_key: r['template_key'] == null ? null : String(r['template_key']),
		inferred_capabilities: String(r['inferred_capabilities']),
		inference_partial: Number(r['inference_partial']) === 1 ? 1 : 0,
		read_only: Number(r['read_only']) === 1 ? 1 : 0,
		idempotent: Number(r['idempotent']) === 1 ? 1 : 0,
		destructive: Number(r['destructive']) === 1 ? 1 : 0,
		created_at: String(r['created_at']),
		updated_at: String(r['updated_at']),
	}
}
