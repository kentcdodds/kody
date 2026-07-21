import { expect, test, vi } from 'vitest'
import type * as sourceSafetyPolicyModule from '#worker/repo/source-safety-policy.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	upsertSavedPackageVector: vi.fn(),
	getEntitySourceByEntity: vi.fn(),
	loadPriorPackageManifestContent: vi.fn(),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		mockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

vi.mock('#worker/package-registry/vectorize.ts', () => ({
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByEntity: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByEntity(...args),
}))

vi.mock('#worker/repo/source-safety-policy.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof sourceSafetyPolicyModule>()
	return {
		...actual,
		loadPriorPackageManifestContent: (...args: Array<unknown>) =>
			mockModule.loadPriorPackageManifestContent(...args),
		assertPackageSourceOverwriteAllowed: vi.fn(async () => undefined),
	}
})

const { savePackageCapability } = await import('./save-package.ts')

function createDatabase(
	initialRows: {
		users?: Array<Record<string, unknown>>
		saved_packages?: Array<Record<string, unknown>>
	} = {},
) {
	const tables = new Map<string, Array<Record<string, unknown>>>([
		['users', (initialRows.users ?? []).map((row) => ({ ...row }))],
		[
			'saved_packages',
			(initialRows.saved_packages ?? []).map((row) => ({ ...row })),
		],
	])

	const clone = <T>(value: T): T => structuredClone(value)

	function getTable(name: string) {
		const table = tables.get(name)
		if (!table) throw new Error(`Unknown table ${name}`)
		return table
	}

	function selectOne(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		return clone(getTable(tableName).find(predicate) ?? null)
	}

	function selectAll(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean = () => true,
	) {
		return clone(getTable(tableName).filter(predicate))
	}

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								return selectOne(
									'users',
									(row) => row['email'] === params[0],
								) as T | null
							}
							if (
								query.includes('SELECT username') &&
								query.includes('FROM users')
							) {
								return selectOne(
									'users',
									(row) =>
										String(row['email']).toLowerCase() ===
										String(params[0]).toLowerCase(),
								) as T | null
							}
							if (
								query.includes('SELECT COUNT(*) AS count FROM saved_packages')
							) {
								return {
									count: selectAll(
										'saved_packages',
										(row) => row['user_id'] === params[0],
									).length,
								} as T
							}
							if (
								query.includes('FROM saved_packages') &&
								query.includes('WHERE id = ? AND user_id = ?')
							) {
								return selectOne(
									'saved_packages',
									(row) =>
										row['id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							if (
								query.includes('FROM saved_packages') &&
								query.includes('WHERE kody_id = ? AND user_id = ?')
							) {
								return selectOne(
									'saved_packages',
									(row) =>
										row['kody_id'] === params[0] &&
										row['user_id'] === params[1],
								) as T | null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all<T = Record<string, unknown>>() {
							if (
								query.includes('FROM saved_packages') &&
								query.includes('WHERE user_id = ?')
							) {
								return {
									results: selectAll(
										'saved_packages',
										(row) => row['user_id'] === params[0],
									),
								} as { results: Array<T> }
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
						async run() {
							if (query.includes('INSERT INTO saved_packages')) {
								getTable('saved_packages').push({
									id: params[0],
									user_id: params[1],
									name: params[2],
									kody_id: params[3],
									description: params[4],
									tags_json: params[5],
									search_text: params[6],
									source_id: params[7],
									has_app: params[8],
									hidden: params[9],
									created_at: params[10],
									updated_at: params[11],
								})
								return { meta: { changes: 1 } }
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function buildPackageFiles(kodyId: string, username: string) {
	return [
		{
			path: 'package.json',
			content: JSON.stringify({
				name: `@${username}/${kodyId}`,
				exports: { '.': './src/index.ts' },
				kody: {
					id: kodyId,
					description: `Package ${kodyId}`,
				},
			}),
		},
		{
			path: 'src/index.ts',
			content: 'export default async function main() { return { ok: true } }\n',
		},
	]
}

function setupPersistenceMocks() {
	mockModule.ensureEntitySource.mockReset()
	mockModule.syncArtifactSourceSnapshot.mockReset()
	mockModule.refreshSavedPackageProjection.mockReset()
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.getEntitySourceByEntity.mockReset()
	mockModule.loadPriorPackageManifestContent.mockReset()

	mockModule.ensureEntitySource.mockImplementation(
		async ({ entityId, userId }) => ({
			id: `source-${entityId}`,
			user_id: userId,
			entity_kind: 'package',
			entity_id: entityId,
			repo_id: `repo-${entityId}`,
			published_commit: 'published-commit-1',
			indexed_commit: 'published-commit-1',
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
			bootstrapAccess: null,
		}),
	)
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('published-commit-1')
	mockModule.refreshSavedPackageProjection.mockImplementation(
		async ({ packageId, userId }) => ({
			record: {
				id: packageId,
				userId,
				name: '@planned/pkg',
				kodyId: 'pkg',
				description: 'Package pkg',
				tags: [],
				searchText: null,
				sourceId: `source-${packageId}`,
				hasApp: false,
				hidden: false,
				isPrivate: false,
				createdAt: '2026-04-18T00:00:00.000Z',
				updatedAt: '2026-04-18T00:00:00.000Z',
			},
		}),
	)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.getEntitySourceByEntity.mockImplementation(
		async ({ entityId, userId }) => ({
			id: `source-${entityId}`,
			user_id: userId,
			entity_kind: 'package',
			entity_id: entityId,
			repo_id: `repo-${entityId}`,
			published_commit: 'published-commit-1',
			indexed_commit: 'published-commit-1',
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-18T00:00:00.000Z',
			updated_at: '2026-04-18T00:00:00.000Z',
		}),
	)
	mockModule.loadPriorPackageManifestContent.mockResolvedValue(null)
}

function createHandlerContext(input: {
	db: D1Database
	userId: string
	email: string
}) {
	return {
		env: { APP_DB: input.db } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: input.userId,
				email: input.email,
				displayName: 'Planned User',
			},
		}),
	}
}

test('package_save enforces the saved packages entitlement for plan users on create', async () => {
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxSavedPackages
	if (limit === null) throw new Error('Expected a numeric pro package limit.')
	const now = '2026-04-18T00:00:00.000Z'
	const savedPackages = Array.from({ length: limit }, (_, index) => ({
		id: `package-${index}`,
		user_id: userId,
		name: `@planned/existing-${index}`,
		kody_id: `existing-${index}`,
		description: 'Existing package',
		tags_json: '[]',
		search_text: null,
		source_id: `source-existing-${index}`,
		has_app: 0,
		created_at: now,
		updated_at: now,
	}))
	const db = createDatabase({
		users: [{ email, plan: 'pro', username: 'planned' }],
		saved_packages: savedPackages,
	})
	setupPersistenceMocks()
	const ctx = createHandlerContext({ db, userId, email })

	const error = await savePackageCapability
		.handler({ files: buildPackageFiles('new-package', 'planned') }, ctx)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from package_save.')
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'saved_packages',
		plan: 'pro',
		limit,
		current: limit,
	})
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
})

test('package_save does not gate updates to an existing package at the limit', async () => {
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxSavedPackages
	if (limit === null) throw new Error('Expected a numeric pro package limit.')
	const now = '2026-04-18T00:00:00.000Z'
	const existingPackageId = 'package-existing'
	const savedPackages = [
		...Array.from({ length: limit }, (_, index) => ({
			id: `package-${index}`,
			user_id: userId,
			name: `@planned/existing-${index}`,
			kody_id: `existing-${index}`,
			description: 'Existing package',
			tags_json: '[]',
			search_text: null,
			source_id: `source-existing-${index}`,
			has_app: 0,
			created_at: now,
			updated_at: now,
		})),
		{
			id: existingPackageId,
			user_id: userId,
			name: '@planned/updatable-package',
			kody_id: 'updatable-package',
			description: 'Updatable package',
			tags_json: '[]',
			search_text: null,
			source_id: 'source-updatable',
			has_app: 0,
			created_at: now,
			updated_at: now,
		},
	]
	const db = createDatabase({
		users: [{ email, plan: 'pro', username: 'planned' }],
		saved_packages: savedPackages,
	})
	setupPersistenceMocks()
	const ctx = createHandlerContext({ db, userId, email })

	await savePackageCapability.handler(
		{
			package_id: existingPackageId,
			confirm_destructive_overwrite: true,
			files: buildPackageFiles('updatable-package', 'planned'),
		},
		ctx,
	)

	expect(mockModule.ensureEntitySource).toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
})

test('package_save responses steer coding agents toward the git lane', async () => {
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const db = createDatabase({
		users: [{ email, plan: null, username: 'planned' }],
	})
	setupPersistenceMocks()
	const ctx = createHandlerContext({ db, userId, email })

	const result = await savePackageCapability.handler(
		{ files: buildPackageFiles('steered-package', 'planned') },
		ctx,
	)

	expect(result.next_steps).toContain('package_get_git_remote')
	expect(result.next_steps).toContain('package_publish_external_push')
	expect(result.next_steps).toContain(JSON.stringify(result.kody_id))
	expect(result.pending_secret_package_approvals).toBeNull()
})

test('package_save stays unlimited for users without a plan', async () => {
	const email = 'legacy@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.free.maxSavedPackages
	if (limit === null) throw new Error('Expected a numeric free package limit.')
	const db = createDatabase({
		users: [{ email, plan: null, username: 'legacy' }],
	})
	setupPersistenceMocks()
	const ctx = createHandlerContext({ db, userId, email })

	for (let index = 0; index < limit + 1; index += 1) {
		await savePackageCapability.handler(
			{ files: buildPackageFiles(`legacy-package-${index}`, 'legacy') },
			ctx,
		)
	}

	expect(mockModule.ensureEntitySource).toHaveBeenCalledTimes(limit + 1)
})
