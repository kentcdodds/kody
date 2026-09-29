import { expect, test, vi } from 'vitest'
import type * as sourceSafetyPolicyModule from '#worker/repo/source-safety-policy.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#universal/plans.ts'
import { maxRepoSourceFileBytes } from '#worker/repo/large-file-policy.ts'
import { PackagePublishLockedError } from '#worker/package-registry/package-publish-lock.ts'
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

type Row = Record<string, unknown>
const now = '2026-04-18T00:00:00.000Z'
const savedPackageInsertColumns = [
	'id',
	'user_id',
	'name',
	'kody_id',
	'description',
	'tags_json',
	'search_text',
	'source_id',
	'has_app',
	'hidden',
	'is_private',
	'created_at',
	'updated_at',
]

function createDatabase(
	users: Array<Row>,
	savedPackages: Array<Row>,
	{ failInsertWithUniqueName = false } = {},
) {
	const find = (rows: Array<Row>, predicate: (row: Row) => boolean) =>
		structuredClone(rows.find(predicate) ?? null)
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					const [first, second] = params
					const lookupColumn =
						/WHERE (id|kody_id|name) = \? AND user_id = \?/.exec(query)?.[1]
					return {
						async first() {
							if (query.includes('SELECT plan, stripe_plan')) {
								return find(
									users,
									(row) =>
										row['email'] === first && row['stable_user_id'] === second,
								)
							}
							if (
								query.includes('SELECT username') &&
								query.includes('FROM users') &&
								query.includes('stable_user_id')
							) {
								return find(users, (row) => row['stable_user_id'] === first)
							}
							if (
								query.includes('SELECT COUNT(*) AS count FROM saved_packages')
							) {
								return {
									count: savedPackages.filter((row) => row['user_id'] === first)
										.length,
								}
							}
							if (query.includes('FROM saved_packages') && lookupColumn) {
								return find(
									savedPackages,
									(row) =>
										row[lookupColumn] === first && row['user_id'] === second,
								)
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all() {
							if (
								query.includes('FROM saved_packages') &&
								query.includes('WHERE user_id = ?')
							) {
								return {
									results: structuredClone(
										savedPackages.filter((row) => row['user_id'] === first),
									),
								}
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
						async run() {
							if (!query.includes('INSERT INTO saved_packages')) {
								throw new Error(`Unsupported run query: ${query}`)
							}
							if (failInsertWithUniqueName) {
								throw new Error(
									'D1_ERROR: UNIQUE constraint failed: saved_packages.user_id, saved_packages.name: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)',
								)
							}
							savedPackages.push(
								Object.fromEntries(
									savedPackageInsertColumns.map((column, index) => [
										column,
										params[index],
									]),
								),
							)
							return { meta: { changes: 1 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function savedPackageRow(
	userId: string,
	id: string,
	kodyId: string,
	extra: Row = {},
) {
	return {
		id,
		user_id: userId,
		name: `@planned/${kodyId}`,
		kody_id: kodyId,
		description: 'Existing package',
		tags_json: '[]',
		search_text: null,
		source_id: `source-${id}`,
		has_app: 0,
		created_at: now,
		updated_at: now,
		...extra,
	}
}

function filledPackages(userId: string, count: number | null) {
	if (count === null) throw new Error('Expected a numeric package limit.')
	return Array.from({ length: count }, (_, index) =>
		savedPackageRow(userId, `package-${index}`, `existing-${index}`),
	)
}

function buildPackageFiles(
	kodyId: string,
	{
		username = 'planned',
		name = `@${username}/${kodyId}`,
		...manifest
	}: { username?: string; name?: string; private?: boolean } = {},
) {
	return [
		{
			path: 'package.json',
			content: JSON.stringify({
				name,
				...manifest,
				exports: { '.': './src/index.ts' },
				kody: { id: kodyId, description: `Package ${kodyId}` },
			}),
		},
		{
			path: 'src/index.ts',
			content: 'export default async function main() { return { ok: true } }\n',
		},
	]
}

function sourceRow({ entityId, userId }: { entityId: string; userId: string }) {
	return {
		id: `source-${entityId}`,
		user_id: userId,
		entity_kind: 'package',
		entity_id: entityId,
		repo_id: `repo-${entityId}`,
		published_commit: 'published-commit-1',
		indexed_commit: 'published-commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		created_at: now,
		updated_at: now,
	}
}

async function setup({
	email = 'planned@example.com',
	plan = 'pro',
	username = 'planned',
	savedPackages = () => [],
	failInsertWithUniqueName = false,
}: {
	email?: string
	plan?: string
	username?: string
	savedPackages?: (userId: string) => Array<Row>
	failInsertWithUniqueName?: boolean
} = {}) {
	for (const mock of Object.values(mockModule)) mock.mockReset()
	mockModule.ensureEntitySource.mockImplementation(async (input) => ({
		...sourceRow(input),
		bootstrapAccess: null,
	}))
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
				lockedAt: null,
				createdAt: now,
				updatedAt: now,
			},
		}),
	)
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.getEntitySourceByEntity.mockImplementation(async (input) =>
		sourceRow(input),
	)
	mockModule.deleteEntitySource.mockResolvedValue(true)
	mockModule.loadPriorPackageManifestContent.mockResolvedValue(null)

	const userId = await createStableUserIdFromEmail(email)
	const rows = savedPackages(userId)
	const db = createDatabase(
		[{ email, plan, username, stable_user_id: userId }],
		rows,
		{ failInsertWithUniqueName },
	)
	const ctx = {
		env: { APP_DB: db } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: { userId, email, displayName: 'Planned User' },
		}),
	}
	const save = (args: Record<string, unknown>) =>
		savePackageCapability.handler(args, ctx)
	return { userId, rows, save }
}

const rejection = (promise: Promise<unknown>) =>
	promise.then(
		() => null,
		(thrown: unknown) => thrown,
	)

function readSyncedPackageJson() {
	const syncCall = mockModule.syncArtifactSourceSnapshot.mock.calls.at(-1)
	if (!syncCall) throw new Error('Expected syncArtifactSourceSnapshot call.')
	const files = (syncCall[0] as { files: Record<string, string> }).files
	return JSON.parse(files['package.json'] ?? '{}') as Record<string, unknown>
}

test('packageSave allows below-limit creates and denies creates at the pro and max plan ceilings', async () => {
	const below = await setup({
		email: 'max@example.com',
		plan: 'max',
		username: 'max',
		savedPackages: (userId) =>
			filledPackages(userId, planLimits.pro.maxSavedPackages),
	})
	await below.save({
		files: buildPackageFiles('below-max-package', { username: 'max' }),
	})
	expect(mockModule.ensureEntitySource).toHaveBeenCalled()

	for (const plan of ['pro', 'max'] as const) {
		const limit = planLimits[plan].maxSavedPackages
		const { save } = await setup({
			email: `${plan}@example.com`,
			plan,
			username: plan,
			savedPackages: (userId) => filledPackages(userId, limit),
		})

		const error = await rejection(
			save({ files: buildPackageFiles('new-package', { username: plan }) }),
		)

		if (!isEntitlementLimitError(error)) {
			throw new Error(`Expected an EntitlementLimitError for ${plan}.`)
		}
		expect(error.details).toMatchObject({
			code: 'entitlement_limit_exceeded',
			resource: 'saved_packages',
			plan,
			limit,
			current: limit,
		})
		expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	}
})

test('packageSave does not gate updates to an existing package at the limit', async () => {
	const { save } = await setup({
		savedPackages: (userId) => [
			...filledPackages(userId, planLimits.pro.maxSavedPackages),
			savedPackageRow(userId, 'package-existing', 'updatable-package'),
		],
	})

	await save({
		package_id: 'package-existing',
		confirm_destructive_overwrite: true,
		files: buildPackageFiles('updatable-package'),
	})

	expect(mockModule.ensureEntitySource).toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
})

test('packageSave maps id mismatch, legacy name collision, and UNIQUE insert races to caller errors', async () => {
	const privateCreate = {
		confirm_destructive_overwrite: false,
		confirm_private_visibility_change: false,
	}
	const expectCallerError = async (
		promise: Promise<unknown>,
		message: string | RegExp,
	) => {
		const error = await rejection(promise)
		expect(error).toBeInstanceOf(McpCallerError)
		expect((error as Error).message).toEqual(
			typeof message === 'string' ? message : expect.stringMatching(message),
		)
	}

	const mismatch = await setup({
		email: 'mismatch@example.com',
		username: 'collision',
		savedPackages: (userId) => [
			savedPackageRow(userId, 'existing-package-id', 'pkg', {
				name: '@collision/pkg',
				hidden: 0,
				is_private: 1,
			}),
		],
	})
	await expectCallerError(
		mismatch.save({
			...privateCreate,
			package_id: 'fabricated-package-id',
			files: buildPackageFiles('pkg', {
				name: '@collision/pkg',
				private: true,
			}),
		}),
		buildSavedPackageIdMismatchMessage({
			requestedPackageId: 'fabricated-package-id',
			existingKodyId: 'pkg',
			existingPackageId: 'existing-package-id',
		}),
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	const sharedName = '@collision/new-kody'
	const legacy = await setup({
		email: 'legacy@example.com',
		username: 'collision',
		savedPackages: (userId) => [
			// Legacy row: name leaf no longer matches kody_id, so kody_id
			// lookup misses while (user_id, name) still conflicts.
			savedPackageRow(userId, 'legacy-package-id', 'legacy-other', {
				name: sharedName,
				hidden: 0,
				is_private: 1,
			}),
		],
	})
	await expectCallerError(
		legacy.save({
			...privateCreate,
			files: buildPackageFiles('new-kody', { name: sharedName, private: true }),
		}),
		buildSavedPackageNameCollisionMessage({
			name: sharedName,
			existingKodyId: 'legacy-other',
			existingPackageId: 'legacy-package-id',
		}),
	)
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	const race = await setup({
		email: 'race@example.com',
		username: 'race',
		failInsertWithUniqueName: true,
	})
	await expectCallerError(
		race.save({
			...privateCreate,
			files: buildPackageFiles('pkg', { username: 'race', private: true }),
		}),
		/A saved package named "@race\/pkg" already exists/,
	)
	expect(mockModule.syncArtifactSourceSnapshot).toHaveBeenCalled()
	expect(mockModule.deleteEntitySource.mock.calls).toEqual([
		[
			expect.anything(),
			{ id: expect.stringMatching(/^source-/), userId: race.userId },
		],
	])
})

test('packageSave keeps new packages private unless an explicit private:false is confirmed', async () => {
	const visibilityUser = {
		email: 'visibility@example.com',
		plan: 'max',
		username: 'visibility',
	}

	// The confirmation flag alone never requests public visibility; it
	// only approves an explicit manifest state. Omission stays private.
	const omitted = await setup(visibilityUser)
	await omitted.save({
		files: buildPackageFiles('new-package', { username: 'visibility' }),
		confirm_private_visibility_change: true,
	})
	expect(readSyncedPackageJson()['private']).toBe(true)
	expect(omitted.rows.at(-1)?.['is_private']).toBe(1)

	// Leftover private:false stays in the manifest but not catalog visibility.
	const leftover = await setup(visibilityUser)
	await leftover.save({
		files: buildPackageFiles('new-package', {
			username: 'visibility',
			private: false,
		}),
		confirm_private_visibility_change: true,
	})
	expect(readSyncedPackageJson()['private']).toBe(false)
	expect(leftover.rows.at(-1)?.['is_private']).toBe(1)

	const unconfirmed = await setup(visibilityUser)
	await expect(
		unconfirmed.save({
			files: buildPackageFiles('new-package', {
				username: 'visibility',
				private: false,
			}),
		}),
	).rejects.toThrow('confirm_private_visibility_change')
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('packageSave lock approval keeps the stored kody id during a rename', async () => {
	const { save } = await setup({
		savedPackages: (userId) => [
			savedPackageRow(userId, 'package-existing', 'current-package', {
				hidden: 0,
				is_private: 0,
				locked_at: now,
			}),
		],
	})
	mockModule.syncArtifactSourceSnapshot.mockRejectedValue(
		new PackagePublishLockedError({
			packageId: 'package-existing',
			packageName: '@planned/current-package',
			pendingCommit: 'abc1234',
			currentPublishedCommit: 'def5678',
		}),
	)

	const error = await rejection(
		save({
			package_id: 'package-existing',
			confirm_destructive_overwrite: true,
			files: buildPackageFiles('renamed-package'),
		}),
	)

	expect(error).toBeInstanceOf(Error)
	expect((error as Error).message).toContain(
		'https://example.com/@planned/current-package/approve-publish?commit=abc1234',
	)
	expect((error as Error).message).not.toContain('/renamed-package/')
})

test('packageSave rejects a file over the per-file repo size limit with hosting guidance', async () => {
	const { save } = await setup({ plan: 'max' })

	const error = await rejection(
		save({
			files: [
				...buildPackageFiles('oversized-package'),
				{
					path: 'assets/dataset.csv',
					content: 'x'.repeat(maxRepoSourceFileBytes + 1),
				},
			],
		}),
	)

	expect(error).toBeInstanceOf(Error)
	const message = (error as Error).message
	expect(message).toContain('"assets/dataset.csv"')
	expect(message).toContain('per-file limit')
	expect(message).toContain('Cloudflare R2')
	expect(mockModule.ensureEntitySource).not.toHaveBeenCalled()
	expect(mockModule.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
})

test('packageSave responses steer coding agents toward the git lane', async () => {
	const { save } = await setup({ plan: 'max' })

	const result = await save({ files: buildPackageFiles('steered-package') })

	expect(result.next_steps).toContain('packageGetGitRemote')
	expect(result.next_steps).toContain('packagePublishExternalPush')
	expect(result.next_steps).toContain(JSON.stringify(result.package_id))
	expect(result.pending_secret_package_approvals).toBeNull()
})
