import { expect, test, vi } from 'vitest'
import type * as sourceSafetyPolicyModule from '#worker/repo/source-safety-policy.ts'
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

function createDatabase(users: Array<Record<string, unknown>>) {
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								const email = params[0]
								const stableUserId = params[1]
								if (
									typeof email !== 'string' ||
									typeof stableUserId !== 'string'
								) {
									return null
								}
								return (
									users.find(
										(row) =>
											row['email'] === email &&
											row['stable_user_id'] === stableUserId,
									) ?? null
								)
							}
							if (
								query.includes('SELECT username') &&
								query.includes('FROM users') &&
								query.includes('stable_user_id')
							) {
								return (
									users.find((row) => row['stable_user_id'] === params[0]) ??
									null
								)
							}
							if (
								query.includes('SELECT COUNT(*) AS count FROM saved_packages')
							) {
								return { count: 0 }
							}
							if (query.includes('FROM saved_packages')) {
								return null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async run() {
							if (query.includes('INSERT INTO saved_packages')) {
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
			created_at: '2026-07-10T00:00:00.000Z',
			updated_at: '2026-07-10T00:00:00.000Z',
			bootstrapAccess: null,
		}),
	)
	mockModule.syncArtifactSourceSnapshot.mockResolvedValue('published-commit-1')
	mockModule.refreshSavedPackageProjection.mockImplementation(
		async ({ packageId, userId }) => ({
			record: {
				id: packageId,
				userId,
				name: '@visibility/pkg',
				kodyId: 'pkg',
				description: 'Package pkg',
				tags: [],
				searchText: null,
				sourceId: `source-${packageId}`,
				hasApp: false,
				hidden: false,
				isPrivate: false,
				createdAt: '2026-07-10T00:00:00.000Z',
				updatedAt: '2026-07-10T00:00:00.000Z',
			},
		}),
	)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.getEntitySourceByEntity.mockResolvedValue(null)
	mockModule.loadPriorPackageManifestContent.mockResolvedValue(null)
}

function buildPackageFiles(input: { privateField?: boolean }) {
	return [
		{
			path: 'package.json',
			content: JSON.stringify({
				name: '@visibility/new-package',
				...(input.privateField === undefined
					? {}
					: { private: input.privateField }),
				exports: { '.': './src/index.ts' },
				kody: {
					id: 'new-package',
					description: 'Package new-package',
				},
			}),
		},
		{
			path: 'src/index.ts',
			content: 'export default async function main() { return { ok: true } }\n',
		},
	]
}

async function createContext() {
	const email = 'visibility@example.com'
	const userId = await createStableUserIdFromEmail(email)
	return {
		env: {
			APP_DB: createDatabase([
				{
					email,
					plan: 'max',
					username: 'visibility',
					stable_user_id: userId,
				},
			]),
		} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId,
				email,
				displayName: 'Visibility User',
			},
		}),
	}
}

function readSyncedPackageJson() {
	const syncCall = mockModule.syncArtifactSourceSnapshot.mock.calls.at(-1)
	if (!syncCall) throw new Error('Expected syncArtifactSourceSnapshot call.')
	const files = (syncCall[0] as { files: Record<string, string> }).files
	return JSON.parse(files['package.json'] ?? '{}') as Record<string, unknown>
}

test('package_save injects private:true for new packages that omit private, even with confirm_private_visibility_change', async () => {
	setupPersistenceMocks()
	const ctx = await createContext()

	await savePackageCapability.handler(
		{
			files: buildPackageFiles({}),
			// The confirmation flag alone never requests public visibility; it
			// only approves an explicit manifest state. Omission stays private.
			confirm_private_visibility_change: true,
		},
		ctx,
	)

	expect(readSyncedPackageJson()['private']).toBe(true)
})

test('package_save creates a public package only with an explicit private:false plus confirmation', async () => {
	setupPersistenceMocks()
	const ctx = await createContext()

	await savePackageCapability.handler(
		{
			files: buildPackageFiles({ privateField: false }),
			confirm_private_visibility_change: true,
		},
		ctx,
	)

	expect(readSyncedPackageJson()['private']).toBe(false)
})

test('package_save rejects an explicit private:false create without confirmation', async () => {
	setupPersistenceMocks()
	const ctx = await createContext()

	await expect(
		savePackageCapability.handler(
			{ files: buildPackageFiles({ privateField: false }) },
			ctx,
		),
	).rejects.toThrow('confirm_private_visibility_change')

	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})
