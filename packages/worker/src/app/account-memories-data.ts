import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import { listMemoriesByUserId } from '#mcp/memory/repo.ts'
import { getMemory } from '#mcp/memory/service.ts'
import { type MemoryRecord, type MemoryStatus } from '#mcp/memory/types.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export type AccountMemoryListItem = {
	id: string
	subject: string
	category: string | null
	status: MemoryStatus
	tags: Array<string>
	summary: string
	updatedAt: string
}

export type AccountMemoryDetail = AccountMemoryListItem & {
	details: string
	sourceUris: Array<string>
	dedupeKey: string | null
	createdAt: string
	lastAccessedAt: string | null
	deletedAt: string | null
}

export type AccountMemoriesLoaderData = {
	ok: true
	email: string
	username: string
	memories: Array<AccountMemoryListItem>
	selectedMemory: AccountMemoryDetail | null
	query: string
	includeDeleted: boolean
}

const accountMemoriesBasePath = '/account/memories'

export function readAccountMemoriesSelectedMemoryId(
	requestUrl: string,
	pathMemoryId?: string,
) {
	if (pathMemoryId?.trim()) return pathMemoryId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountMemoriesBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const memoryId = decodeURIComponent(segment)
				if (memoryId) return memoryId
			} catch {
				if (segment) return segment
			}
		}
	}
	const selected = url.searchParams.get('selected')?.trim()
	return selected ? selected : null
}

export function readAccountMemoriesIncludeDeleted(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	const raw = url.searchParams.get('includeDeleted')?.trim().toLowerCase()
	return raw === '1' || raw === 'true' || raw === 'yes'
}

export function readAccountMemoriesQuery(requestUrl: string) {
	const url = new URL(requestUrl, 'http://localhost')
	return url.searchParams.get('q')?.trim() ?? ''
}

function toListItem(memory: MemoryRecord): AccountMemoryListItem {
	return {
		id: memory.id,
		subject: memory.subject,
		category: memory.category,
		status: memory.status,
		tags: memory.tags,
		summary: memory.summary,
		updatedAt: memory.updatedAt,
	}
}

function toDetail(memory: MemoryRecord): AccountMemoryDetail {
	return {
		...toListItem(memory),
		details: memory.details,
		sourceUris: memory.sourceUris,
		dedupeKey: memory.dedupeKey,
		createdAt: memory.createdAt,
		lastAccessedAt: memory.lastAccessedAt,
		deletedAt: memory.deletedAt,
	}
}

export function memoryMatchesQuery(
	memory: AccountMemoryListItem,
	query: string,
) {
	const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
	if (tokens.length === 0) return true
	const haystack = [
		memory.subject,
		memory.category,
		memory.status,
		memory.summary,
		...memory.tags,
	]
		.filter((value): value is string => typeof value === 'string')
		.join(' ')
		.toLocaleLowerCase()
	return tokens.every((token) => haystack.includes(token))
}

export async function loadAccountMemoriesData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	pathMemoryId?: string
}): Promise<AccountMemoriesLoaderData> {
	const userId = input.user.mcpUser.userId
	const query = readAccountMemoriesQuery(input.request.url)
	const includeDeleted = readAccountMemoriesIncludeDeleted(input.request.url)
	const selectedMemoryId = readAccountMemoriesSelectedMemoryId(
		input.request.url,
		input.pathMemoryId,
	)
	const statuses: Array<MemoryStatus> = includeDeleted
		? ['active', 'archived', 'deleted']
		: ['active', 'archived']

	const rows = await listMemoriesByUserId(input.env.APP_DB, userId, {
		statuses,
		limit: 100,
	})
	const memories = rows
		.map((row) =>
			toListItem({
				id: row.id,
				category: row.category,
				status: row.status,
				subject: row.subject,
				summary: row.summary,
				details: row.details,
				tags: parseJsonStringArray(row.tags_json),
				sourceUris: parseJsonStringArray(row.source_uris_json),
				dedupeKey: row.dedupe_key,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				lastAccessedAt: row.last_accessed_at,
				deletedAt: row.deleted_at,
			}),
		)
		.filter((memory) => memoryMatchesQuery(memory, query))

	const selectedMemory = selectedMemoryId
		? await resolveSelectedMemory({
				env: input.env,
				userId,
				memoryId: selectedMemoryId,
			})
		: null

	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		memories,
		selectedMemory,
		query,
		includeDeleted,
	}
}

async function resolveSelectedMemory(input: {
	env: Env
	userId: string
	memoryId: string
}): Promise<AccountMemoryDetail | null> {
	const memory = await getMemory({
		env: input.env,
		userId: input.userId,
		memoryId: input.memoryId,
	})
	return memory ? toDetail(memory) : null
}
