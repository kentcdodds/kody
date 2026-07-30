import {
	assertOpenApiBindingWithinSizeLimit,
	parseOpenApiBinding,
	type OpenApiBinding,
} from '#worker/openapi/binding-shared.ts'
import {
	deleteOpenApiBindingByName,
	getOpenApiBindingByName,
	listOpenApiBindingsForUser,
	upsertOpenApiBinding,
	type OpenApiBindingWithOperations,
} from '#worker/openapi/repo.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'

export async function listOpenApiBindings(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<Array<OpenApiBinding>> {
	const rows = await listOpenApiBindingsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	const bindings: Array<OpenApiBinding> = []
	for (const row of rows) {
		const parsed = toOpenApiBinding(row)
		if (parsed) bindings.push(parsed)
	}
	return bindings
}

export const openApiBindingsCacheTtlMs = 30_000
export const openApiBindingsCacheLimit = 200

function createOpenApiBindingsCache() {
	return new PromiseLruCache<ReadonlyArray<OpenApiBinding>>({
		ttlMs: openApiBindingsCacheTtlMs,
		limit: openApiBindingsCacheLimit,
	})
}

let openApiBindingsCache = createOpenApiBindingsCache()

/**
 * Short-TTL per-user cache over {@link listOpenApiBindings} for hot
 * invocation paths (capability-registry assembly pays this D1 read on every
 * run otherwise). Mutations in this module invalidate eagerly, so
 * same-isolate staleness after save / delete is zero; other isolates
 * converge within the TTL — the same bound the capability-registry cache
 * uses. Listing surfaces (UI, `openapi_binding_list`) should keep using the
 * uncached function.
 */
export function listOpenApiBindingsCached(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}): Promise<ReadonlyArray<OpenApiBinding>> {
	return openApiBindingsCache.getOrCreate({
		cacheKey: input.userId,
		create: async () => Object.freeze(await listOpenApiBindings(input)),
	})
}

function invalidateOpenApiBindingsCache(input: { userId: string }) {
	openApiBindingsCache.delete(input.userId)
}

export function clearOpenApiBindingsCacheForTests() {
	openApiBindingsCache = createOpenApiBindingsCache()
}

export async function getOpenApiBinding(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<OpenApiBinding | null> {
	const row = await getOpenApiBindingByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	if (!row) return null
	return toOpenApiBinding(row)
}

export async function saveOpenApiBinding(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	binding: OpenApiBinding
}): Promise<void> {
	assertOpenApiBindingWithinSizeLimit(input.binding)
	const existing = await getOpenApiBindingByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.binding.name,
	})
	await upsertOpenApiBinding({
		db: input.env.APP_DB,
		userId: input.userId,
		binding: input.binding,
		createdAt: existing?.binding.created_at,
	})
	invalidateOpenApiBindingsCache({ userId: input.userId })
}

export async function deleteOpenApiBinding(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
}): Promise<boolean> {
	const deleted = await deleteOpenApiBindingByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	invalidateOpenApiBindingsCache({ userId: input.userId })
	return deleted
}

function toOpenApiBinding(
	row: OpenApiBindingWithOperations,
): OpenApiBinding | null {
	const operations: Array<unknown> = []
	for (const operation of row.operations) {
		const parsed = parseJson(operation.operation_json)
		if (parsed == null) return null
		operations.push(parsed)
	}
	const auth = parseJson(row.binding.auth_json)
	const selection = parseJson(row.binding.selection_json)
	if (auth == null || selection == null) return null

	return parseOpenApiBinding(
		{
			name: row.binding.name,
			specUrl: row.binding.spec_url,
			apiBaseUrl: row.binding.api_base_url,
			description: row.binding.description,
			auth,
			selection,
			includeDestructive: row.binding.include_destructive === 1,
			specTitle: row.binding.spec_title,
			specVersion: row.binding.spec_version,
			operations,
			updatedAt: row.binding.updated_at,
		},
		row.binding.name,
	)
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		return null
	}
}
