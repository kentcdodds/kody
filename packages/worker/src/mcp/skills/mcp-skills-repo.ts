import { listAllApps, listAppRowsByUserId } from '#worker/apps/repo.ts'
import { type AppRecord } from '#worker/apps/types.ts'
import { type McpSkillRow } from './mcp-skills-types.ts'
import { getSkillNameCandidates, normalizeSkillName } from './skill-names.ts'

export function skillVectorId(skillId: string) {
	return `app_task_${skillId}`
}

export function isDuplicateSkillNameError(_error: unknown) {
	return false
}

function appTaskToSkillRow(input: {
	app: AppRecord
	task: AppRecord['tasks'][number]
}): McpSkillRow {
	return {
		id: `${input.app.id}:${input.task.name}`,
		user_id: input.app.userId,
		name: input.task.name,
		title: input.task.title,
		description: input.task.description,
		collection_name: null,
		collection_slug: null,
		source_id: input.app.sourceId,
		keywords: JSON.stringify(input.task.keywords ?? []),
		search_text: input.task.searchText ?? null,
		uses_capabilities: input.task.usesCapabilities
			? JSON.stringify(input.task.usesCapabilities)
			: null,
		parameters: input.task.parameters
			? JSON.stringify(input.task.parameters)
			: null,
		inferred_capabilities:
			input.task.usesCapabilities != null
				? JSON.stringify(input.task.usesCapabilities)
				: '[]',
		inference_partial: 0,
		read_only: input.task.readOnly ? 1 : 0,
		idempotent: input.task.idempotent ? 1 : 0,
		destructive: input.task.destructive ? 1 : 0,
		created_at: input.app.createdAt,
		updated_at: input.app.updatedAt,
	}
}

function appToSkillRows(app: AppRecord) {
	return app.tasks.map((task) => appTaskToSkillRow({ app, task }))
}

export async function insertMcpSkill(): Promise<void> {
	throw new Error('Saved skills are now managed as app tasks.')
}

export async function getMcpSkillByName(
	db: D1Database,
	userId: string,
	skillName: string,
): Promise<McpSkillRow | null> {
	const normalizedSkillName = normalizeSkillName(skillName)
	const rows = await listMcpSkillsByUserId(db, userId)
	return rows.find((row) => row.name === normalizedSkillName) ?? null
}

export async function getMcpSkillByNameCandidates(
	db: D1Database,
	userId: string,
	skillNames: Array<string>,
): Promise<McpSkillRow | null> {
	if (skillNames.length === 0) return null
	const rows = await listMcpSkillsByUserId(db, userId)
	for (const candidate of skillNames) {
		const normalized = normalizeSkillName(candidate)
		const match = rows.find((row) => row.name === normalized)
		if (match) return match
	}
	return null
}

function matchesNormalizedTitle(row: McpSkillRow, normalizedInput: string) {
	try {
		return normalizeSkillName(row.title) === normalizedInput
	} catch {
		return false
	}
}

export async function getMcpSkillByNameInput(
	db: D1Database,
	userId: string,
	inputName: string,
): Promise<McpSkillRow | null> {
	const candidates = getSkillNameCandidates(inputName)
	const direct = await getMcpSkillByNameCandidates(db, userId, candidates)
	if (direct) return direct
	let normalizedInput: string
	try {
		normalizedInput = normalizeSkillName(inputName)
	} catch {
		return null
	}
	const rows = await listMcpSkillsByUserId(db, userId)
	let match: McpSkillRow | null = null
	for (const row of rows) {
		if (!matchesNormalizedTitle(row, normalizedInput)) continue
		if (match) return null
		match = row
	}
	return match
}

export async function updateMcpSkill(): Promise<boolean> {
	throw new Error('Saved skills are now managed as app tasks.')
}

export async function deleteMcpSkill(): Promise<boolean> {
	throw new Error('Saved skills are now managed as app tasks.')
}

export async function listMcpSkillsByUserId(
	db: D1Database,
	userId: string,
): Promise<Array<McpSkillRow>> {
	const apps = await listAppRowsByUserId(db, userId)
	return apps.flatMap(appToSkillRows)
}

export type SkillCollectionSummaryRow = {
	collection_name: string
	collection_slug: string
	skill_count: number
}

export async function listMcpSkillCollectionsByUserId(): Promise<
	Array<SkillCollectionSummaryRow>
> {
	return []
}

export async function listAllMcpSkills(
	db: D1Database,
): Promise<Array<McpSkillRow>> {
	const apps = await listAllApps(db)
	return apps.flatMap(appToSkillRows)
}
