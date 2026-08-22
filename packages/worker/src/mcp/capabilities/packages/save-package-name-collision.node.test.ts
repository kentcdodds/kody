import { expect, test, vi } from 'vitest'
import type * as sourceSafetyPolicyModule from '#worker/repo/source-safety-policy.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	upsertSavedPackageVector: vi.fn(),
	getEntitySourceByEntity: vi.fn(),
	deleteEntitySource: vi.fn(),
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
	deleteEntitySource: (...args: Array<unknown>) =>
		mockModule.deleteEntitySource(...args),
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

const {
	buildSavedPackageIdMismatchMessage,
	buildSavedPackageNameCollisionMessage,
	savePackageCapability,
} = await import('./save-package.ts')

function createDatabase(
	initialRows: {
		users?: Array<Record<string, unknown>>
		saved_packages?: Array<Record<string, unknown>>
	} = {},
	options: { failInsertWithUniqueName?: boolean } = {},
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

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								return selectOne(
									'users',
									(row) =>
										row['email'] === params[0] &&
										row['stable_user_id'] === params[1],
								) as T | null
							}
							if (
								query.includes('SELECT username') &&
								query.includes('FROM users') &&
								query.includes('stable_user_id')
							) {
								return selectOne(
									'users',
									(row) => row['stable_user_id'] === params[0],
								) as T | null
							}
							if (
								query.includes('SELECT COUNT(*) AS count FROM saved_packages')
							) {
								return {
									count: getTable('saved_packages').filter(
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
							if (
								query.includes('FROM saved_packages') &&
								query.includes('WHERE name = ? AND user_id = ?')
							) {
								return selectOne(
									'saved_packages',
									(row) =>
										row['name'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async run() {
							if (query.includes('INSERT INTO saved_packages')) {
								if (options.failInsertWithUniqueName) {
									throw new Error(
										'D1_ERROR: UNIQUE constraint failed: saved_packages.user_id, saved_packages.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
									)
								}
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
									is_private: params[10],
									created_at: params[11],
									updated_at: params[12],
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

function setupPersistenceMocks() {
	mockModule.ensureEntitySource.mockReset()
	mockModule.syncArtifactSourceSnapshot.mockReset()
	mockModule.refreshSavedPackageProjection.mockReset()
	mockModule.upsertSavedPackageVector.mockReset()
	mockModule.getEntitySourceByEntity.mockReset()
	mockModule.deleteEntitySource.mockReset()
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
			created_at: '2026-08-19T00:00:00.000Z',
			updated_at: '2026-08-19T00:00:00.000Z',
			bootstrapAccess: null,
		}),
	)
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('published-commit-1')
	mockModule.refreshSavedPackageProjection.mockImplementation(
		async ({ packageId, userId }) => ({
			record: {
				id: packageId,
				userId,
				name: '@collision/pkg',
				kodyId: 'pkg',
				description: 'Package pkg',
				tags: [],
				searchText: null,
				sourceId: `source-${packageId}`,
				hasApp: false,
				hidden: false,
				isPrivate: true,
				createdAt: '2026-08-19T00:00:00.000Z',
				updatedAt: '2026-08-19T00:00:00.000Z',
			},
		}),
	)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.getEntitySourceByEntity.mockResolvedValue(null)
	mockModule.deleteEntitySource.mockResolvedValue(true)
	mockModule.loadPriorPackageManifestContent.mockResolvedValue(null)
}

function buildPackageFiles(input: { name: string; kodyId: string }) {
	return [
		{
			path: 'package.json',
			content: JSON.stringify({
				name: input.name,
				private: true,
				exports: { '.': './src/index.ts' },
				kody: {
					id: input.kodyId,
					description: `Package ${input.kodyId}`,
				},
			}),
		},
		{
			path: 'src/index.ts',
			content: 'export default async function main() { return { ok: true } }\n',
		},
	]
}

test('package_save maps id mismatch, legacy name collision, and UNIQUE insert races to caller errors', async () => {
	setupPersistenceMocks()
	const mismatchEmail = 'mismatch@example.com'
	const mismatchUserId = await createStableUserIdFromEmail(mismatchEmail)
	const existingPackageId = 'existing-package-id'
	const requestedPackageId = 'fabricated-package-id'
	await expect(
		savePackageCapability.handler(
			{
				package_id: requestedPackageId,
				files: buildPackageFiles({
					name: '@collision/pkg',
					kodyId: 'pkg',
				}),
				confirm_destructive_overwrite: false,
				confirm_private_visibility_change: false,
			},
			{
				env: {
					APP_DB: createDatabase({
						users: [
							{
								email: mismatchEmail,
								plan: 'pro',
								username: 'collision',
								stable_user_id: mismatchUserId,
							},
						],
						saved_packages: [
							{
								id: existingPackageId,
								user_id: mismatchUserId,
								name: '@collision/pkg',
								kody_id: 'pkg',
								description: 'Existing package',
								tags_json: '[]',
								search_text: null,
								source_id: 'source-existing',
								has_app: 0,
								hidden: 0,
								is_private: 1,
								created_at: '2026-08-19T00:00:00.000Z',
								updated_at: '2026-08-19T00:00:00.000Z',
							},
						],
					}),
				} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: mismatchUserId,
						email: mismatchEmail,
						displayName: 'Collision User',
					},
				}),
			} as never,
		),
	).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(McpCallerError)
		expect((error as Error).message).toBe(
			buildSavedPackageIdMismatchMessage({
				requestedPackageId,
				existingKodyId: 'pkg',
				existingPackageId,
			}),
		)
		return true
	})
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	setupPersistenceMocks()
	const legacyEmail = 'legacy@example.com'
	const legacyUserId = await createStableUserIdFromEmail(legacyEmail)
	const legacyPackageId = 'legacy-package-id'
	const sharedName = '@collision/new-kody'
	await expect(
		savePackageCapability.handler(
			{
				files: buildPackageFiles({ name: sharedName, kodyId: 'new-kody' }),
				confirm_destructive_overwrite: false,
				confirm_private_visibility_change: false,
			},
			{
				env: {
					APP_DB: createDatabase({
						users: [
							{
								email: legacyEmail,
								plan: 'pro',
								username: 'collision',
								stable_user_id: legacyUserId,
							},
						],
						saved_packages: [
							{
								id: legacyPackageId,
								user_id: legacyUserId,
								// Legacy row: name leaf no longer matches kody_id, so kody_id
								// lookup misses while (user_id, name) still conflicts.
								name: sharedName,
								kody_id: 'legacy-other',
								description: 'Legacy package',
								tags_json: '[]',
								search_text: null,
								source_id: 'source-legacy',
								has_app: 0,
								hidden: 0,
								is_private: 1,
								created_at: '2026-08-19T00:00:00.000Z',
								updated_at: '2026-08-19T00:00:00.000Z',
							},
						],
					}),
				} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: legacyUserId,
						email: legacyEmail,
						displayName: 'Legacy User',
					},
				}),
			} as never,
		),
	).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(McpCallerError)
		expect((error as Error).message).toBe(
			buildSavedPackageNameCollisionMessage({
				name: sharedName,
				existingKodyId: 'legacy-other',
				existingPackageId: legacyPackageId,
			}),
		)
		return true
	})
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	setupPersistenceMocks()
	const raceEmail = 'race@example.com'
	const raceUserId = await createStableUserIdFromEmail(raceEmail)
	await expect(
		savePackageCapability.handler(
			{
				files: buildPackageFiles({
					name: '@race/pkg',
					kodyId: 'pkg',
				}),
				confirm_destructive_overwrite: false,
				confirm_private_visibility_change: false,
			},
			{
				env: {
					APP_DB: createDatabase(
						{
							users: [
								{
									email: raceEmail,
									plan: 'pro',
									username: 'race',
									stable_user_id: raceUserId,
								},
							],
						},
						{ failInsertWithUniqueName: true },
					),
				} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
					user: {
						userId: raceUserId,
						email: raceEmail,
						displayName: 'Race User',
					},
				}),
			} as never,
		),
	).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(McpCallerError)
		expect((error as Error).message).toMatch(
			/A saved package named "@race\/pkg" already exists/,
		)
		return true
	})
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.deleteEntitySource).toHaveBeenCalledTimes(1)
	expect(mockModule.deleteEntitySource).toHaveBeenCalledWith(
		expect.anything(),
		{
			id: expect.stringMatching(/^source-/),
			userId: raceUserId,
		},
	)
})
