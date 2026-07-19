import { expect, test } from 'vitest'
import {
	clearFeatureFlagUserOverride,
	computeRolloutBucket,
	deleteStaleFeatureFlag,
	getFeatureFlagsForUser,
	isFeatureEnabled,
	listFeatureFlagsForAdmin,
	setFeatureFlagGlobalState,
	setFeatureFlagUserOverride,
} from './service.ts'

type GlobalRow = {
	key: string
	enabled: number
	rollout_percent: number | null
	note: string
	updated_by: number | null
	updated_at: string
}

type OverrideRow = {
	flag_key: string
	user_id: number
	enabled: number
	updated_by: number | null
	updated_at: string
}

type UserRow = {
	id: number
	username: string
}

function createFeatureFlagsTestDb(
	input: {
		globals?: Array<GlobalRow>
		overrides?: Array<OverrideRow>
		users?: Array<UserRow>
	} = {},
) {
	const globals = new Map(
		(input.globals ?? []).map((row) => [row.key, { ...row }]),
	)
	const overrides = new Map(
		(input.overrides ?? []).map((row) => [
			`${row.flag_key}:${row.user_id}`,
			{ ...row },
		]),
	)
	const users = new Map((input.users ?? []).map((row) => [row.id, { ...row }]))
	let clock = 0

	function nextTimestamp() {
		clock += 1
		return `2026-07-19T00:00:${String(clock).padStart(2, '0')}.000Z`
	}

	function normalize(query: string) {
		return query.replace(/\s+/g, ' ').trim().toLowerCase()
	}

	function createStatement(query: string, params: Array<unknown> = []) {
		const normalized = normalize(query)
		return {
			bind(...nextParams: Array<unknown>) {
				return createStatement(query, nextParams)
			},
			async first<T>() {
				if (
					normalized.includes('from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ? and user_id = ?')
				) {
					const row = overrides.get(`${params[0]}:${params[1]}`)
					return (row ? { enabled: row.enabled } : null) as T | null
				}
				if (
					normalized.includes('from feature_flags') &&
					normalized.includes('where key = ?')
				) {
					const row = globals.get(String(params[0]))
					return (
						row
							? {
									enabled: row.enabled,
									rollout_percent: row.rollout_percent,
								}
							: null
					) as T | null
				}
				throw new Error(`Unsupported first query: ${query}`)
			},
			async all<T>() {
				if (
					normalized.includes('from feature_flags') &&
					!normalized.includes('where')
				) {
					return {
						results: [...globals.values()].map((row) => ({ ...row })),
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				if (
					normalized.includes('from feature_flag_user_overrides') &&
					normalized.includes('where user_id = ?')
				) {
					const userId = Number(params[0])
					return {
						results: [...overrides.values()]
							.filter((row) => row.user_id === userId)
							.map((row) => ({
								flag_key: row.flag_key,
								enabled: row.enabled,
							})),
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				if (
					normalized.includes('from feature_flag_user_overrides o') &&
					normalized.includes('join users u')
				) {
					const rows = [...overrides.values()]
						.map((row) => {
							const user = users.get(row.user_id)
							if (!user) return null
							return {
								flag_key: row.flag_key,
								user_id: row.user_id,
								enabled: row.enabled,
								updated_at: row.updated_at,
								username: user.username,
							}
						})
						.filter((row) => row !== null)
						.sort((left, right) => {
							const byKey = left.flag_key.localeCompare(right.flag_key)
							if (byKey !== 0) return byKey
							return left.username.localeCompare(right.username)
						})
					return {
						results: rows,
						meta: { changes: 0 },
					} as { results: Array<T>; meta: { changes: number } }
				}
				throw new Error(`Unsupported all query: ${query}`)
			},
			async run() {
				if (
					normalized.startsWith('insert into feature_flags') &&
					normalized.includes('on conflict(key) do update')
				) {
					const key = String(params[0])
					const enabled = Number(params[1])
					const rolloutPercent =
						params[2] === null || params[2] === undefined
							? null
							: Number(params[2])
					// Emulates COALESCE(?, '') on insert / COALESCE(?, note) on update.
					const noteParam =
						params[3] === null || params[3] === undefined
							? null
							: String(params[3])
					const note = noteParam ?? globals.get(key)?.note ?? ''
					const updatedBy = Number(params[4])
					const updatedAt = nextTimestamp()
					globals.set(key, {
						key,
						enabled,
						rollout_percent: rolloutPercent,
						note,
						updated_by: updatedBy,
						updated_at: updatedAt,
					})
					return { meta: { changes: 1 } }
				}
				if (
					normalized.startsWith('insert into feature_flag_user_overrides') &&
					normalized.includes('on conflict(flag_key, user_id) do update')
				) {
					const flagKey = String(params[0])
					const userId = Number(params[1])
					const enabled = Number(params[2])
					const updatedBy = Number(params[3])
					const updatedAt = nextTimestamp()
					overrides.set(`${flagKey}:${userId}`, {
						flag_key: flagKey,
						user_id: userId,
						enabled,
						updated_by: updatedBy,
						updated_at: updatedAt,
					})
					return { meta: { changes: 1 } }
				}
				if (
					normalized.startsWith('delete from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ? and user_id = ?')
				) {
					const mapKey = `${params[0]}:${params[1]}`
					const existed = overrides.delete(mapKey)
					return { meta: { changes: existed ? 1 : 0 } }
				}
				if (
					normalized.startsWith('delete from feature_flag_user_overrides') &&
					normalized.includes('where flag_key = ?')
				) {
					const flagKey = String(params[0])
					let changes = 0
					for (const mapKey of [...overrides.keys()]) {
						if (mapKey.startsWith(`${flagKey}:`)) {
							overrides.delete(mapKey)
							changes += 1
						}
					}
					return { meta: { changes } }
				}
				if (
					normalized.startsWith('delete from feature_flags') &&
					normalized.includes('where key = ?')
				) {
					const existed = globals.delete(String(params[0]))
					return { meta: { changes: existed ? 1 : 0 } }
				}
				throw new Error(`Unsupported run query: ${query}`)
			},
		}
	}

	const db = {
		prepare(query: string) {
			return createStatement(query)
		},
		async batch(
			statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>,
		) {
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
		globals,
		overrides,
	} as unknown as D1Database & {
		globals: Map<string, GlobalRow>
		overrides: Map<string, OverrideRow>
	}

	return db
}

test('isFeatureEnabled falls back to registry default when no DB state exists', async () => {
	const db = createFeatureFlagsTestDb()
	await expect(isFeatureEnabled(db, 'demo-indicator', 1)).resolves.toBe(false)
	await expect(isFeatureEnabled(db, 'demo-indicator', null)).resolves.toBe(
		false,
	)
	await expect(getFeatureFlagsForUser(db, 1)).resolves.toEqual({
		'demo-indicator': false,
	})
})

test('global on/off and percentage rollout evaluation', async () => {
	const db = createFeatureFlagsTestDb()

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		updatedBy: 9,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 1)).resolves.toBe(false)

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		note: 'fully on',
		updatedBy: 9,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 1)).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'demo-indicator', null)).resolves.toBe(true)

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: 50,
		updatedBy: 9,
	})
	const userIn = 1
	const userOut = 2
	const bucketIn = computeRolloutBucket('demo-indicator', userIn)
	const bucketOut = computeRolloutBucket('demo-indicator', userOut)
	// Pick users whose buckets land on opposite sides of 50 for this key.
	let enabledUser = userIn
	let disabledUser = userOut
	if (bucketIn >= 50 && bucketOut < 50) {
		enabledUser = userOut
		disabledUser = userIn
	} else if (bucketIn >= 50 && bucketOut >= 50) {
		for (let candidate = 3; candidate < 10_000; candidate += 1) {
			if (computeRolloutBucket('demo-indicator', candidate) < 50) {
				enabledUser = candidate
				disabledUser = userIn
				break
			}
		}
	} else if (bucketIn < 50 && bucketOut < 50) {
		for (let candidate = 3; candidate < 10_000; candidate += 1) {
			if (computeRolloutBucket('demo-indicator', candidate) >= 50) {
				disabledUser = candidate
				enabledUser = userIn
				break
			}
		}
	}
	await expect(
		isFeatureEnabled(db, 'demo-indicator', enabledUser),
	).resolves.toBe(true)
	await expect(
		isFeatureEnabled(db, 'demo-indicator', disabledUser),
	).resolves.toBe(false)
	await expect(isFeatureEnabled(db, 'demo-indicator', null)).resolves.toBe(
		false,
	)

	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: 101,
			updatedBy: 9,
		}),
	).rejects.toThrow(/rolloutPercent/)
	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: 12.5,
			updatedBy: 9,
		}),
	).rejects.toThrow(/rolloutPercent/)

	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: null,
			note: 42,
			updatedBy: 9,
		}),
	).rejects.toThrow(/note must be a string/)
	await expect(
		setFeatureFlagGlobalState(db, {
			key: 'demo-indicator',
			enabled: true,
			rolloutPercent: null,
			note: 'x'.repeat(501),
			updatedBy: 9,
		}),
	).rejects.toThrow(/note must be at most 500 characters/)
})

test('omitting note preserves the existing operator note; empty string clears it', async () => {
	const db = createFeatureFlagsTestDb()

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		note: 'keep me',
		updatedBy: 9,
	})
	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		updatedBy: 9,
	})
	expect(db.globals.get('demo-indicator')?.note).toBe('keep me')

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		note: '',
		updatedBy: 9,
	})
	expect(db.globals.get('demo-indicator')?.note).toBe('')
})

test('computeRolloutBucket is deterministic and spreads across 0-99', () => {
	expect(computeRolloutBucket('demo-indicator', 42)).toBe(
		computeRolloutBucket('demo-indicator', 42),
	)
	expect(computeRolloutBucket('demo-indicator', 1)).not.toBe(
		computeRolloutBucket('other-flag', 1),
	)

	const buckets = new Set<number>()
	for (let userId = 1; userId <= 2_000; userId += 1) {
		const bucket = computeRolloutBucket('demo-indicator', userId)
		expect(bucket).toBeGreaterThanOrEqual(0)
		expect(bucket).toBeLessThan(100)
		buckets.add(bucket)
	}
	// Sanity: a decent spread across the 0–99 range for 2000 samples.
	expect(buckets.size).toBeGreaterThan(80)
})

test('user override wins over global off and global on; clear restores evaluation', async () => {
	const db = createFeatureFlagsTestDb()

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: false,
		rolloutPercent: null,
		updatedBy: 1,
	})
	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: 7,
		enabled: true,
		updatedBy: 1,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 7)).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'demo-indicator', 8)).resolves.toBe(false)
	await expect(getFeatureFlagsForUser(db, 7)).resolves.toEqual({
		'demo-indicator': true,
	})

	await setFeatureFlagGlobalState(db, {
		key: 'demo-indicator',
		enabled: true,
		rolloutPercent: null,
		updatedBy: 1,
	})
	await setFeatureFlagUserOverride(db, {
		key: 'demo-indicator',
		userId: 7,
		enabled: false,
		updatedBy: 1,
	})
	await expect(isFeatureEnabled(db, 'demo-indicator', 7)).resolves.toBe(false)
	await expect(isFeatureEnabled(db, 'demo-indicator', 8)).resolves.toBe(true)

	await expect(
		clearFeatureFlagUserOverride(db, { key: 'demo-indicator', userId: 7 }),
	).resolves.toBe(true)
	await expect(isFeatureEnabled(db, 'demo-indicator', 7)).resolves.toBe(true)
	await expect(
		clearFeatureFlagUserOverride(db, { key: 'demo-indicator', userId: 7 }),
	).resolves.toBe(false)
})

test('listFeatureFlagsForAdmin includes registry flags and stale DB-only keys', async () => {
	const db = createFeatureFlagsTestDb({
		users: [
			{ id: 3, username: 'alice' },
			{ id: 4, username: 'bob' },
		],
		globals: [
			{
				key: 'demo-indicator',
				enabled: 1,
				rollout_percent: 25,
				note: 'rolling out',
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
			{
				key: 'retired-flag',
				enabled: 0,
				rollout_percent: null,
				note: 'leftover',
				updated_by: null,
				updated_at: '2026-06-01T00:00:00.000Z',
			},
		],
		overrides: [
			{
				flag_key: 'demo-indicator',
				user_id: 4,
				enabled: 1,
				updated_by: 1,
				updated_at: '2026-07-02T00:00:00.000Z',
			},
			{
				flag_key: 'orphan-override',
				user_id: 3,
				enabled: 0,
				updated_by: 1,
				updated_at: '2026-07-03T00:00:00.000Z',
			},
		],
	})

	const listed = await listFeatureFlagsForAdmin(db)
	expect(listed).toHaveLength(3)

	const demo = listed.find((flag) => flag.key === 'demo-indicator')
	expect(demo).toMatchObject({
		key: 'demo-indicator',
		stale: false,
		defaultEnabled: false,
		global: {
			enabled: true,
			rolloutPercent: 25,
			note: 'rolling out',
			updatedBy: 1,
		},
		overrides: [
			{
				userId: 4,
				username: 'bob',
				enabled: true,
			},
		],
	})
	expect(demo?.description).toContain('exercising the feature flag system')

	const retired = listed.find((flag) => flag.key === 'retired-flag')
	expect(retired).toEqual({
		key: 'retired-flag',
		description: null,
		defaultEnabled: null,
		stale: true,
		global: {
			enabled: false,
			rolloutPercent: null,
			note: 'leftover',
			updatedBy: null,
			updatedAt: '2026-06-01T00:00:00.000Z',
		},
		overrides: [],
	})

	const orphan = listed.find((flag) => flag.key === 'orphan-override')
	expect(orphan).toEqual({
		key: 'orphan-override',
		description: null,
		defaultEnabled: null,
		stale: true,
		global: null,
		overrides: [
			{
				userId: 3,
				username: 'alice',
				enabled: false,
				updatedAt: '2026-07-03T00:00:00.000Z',
			},
		],
	})
})

test('deleteStaleFeatureFlag refuses registry keys and removes stale rows', async () => {
	const db = createFeatureFlagsTestDb({
		users: [{ id: 3, username: 'alice' }],
		globals: [
			{
				key: 'demo-indicator',
				enabled: 1,
				rollout_percent: null,
				note: '',
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
			{
				key: 'retired-flag',
				enabled: 1,
				rollout_percent: null,
				note: '',
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
		],
		overrides: [
			{
				flag_key: 'retired-flag',
				user_id: 3,
				enabled: 1,
				updated_by: 1,
				updated_at: '2026-07-01T00:00:00.000Z',
			},
		],
	})

	await expect(deleteStaleFeatureFlag(db, 'demo-indicator')).rejects.toThrow(
		/Cannot delete registry feature flag/,
	)
	expect(db.globals.has('demo-indicator')).toBe(true)

	await expect(deleteStaleFeatureFlag(db, 'retired-flag')).resolves.toBe(true)
	expect(db.globals.has('retired-flag')).toBe(false)
	expect(db.overrides.size).toBe(0)
	await expect(deleteStaleFeatureFlag(db, 'retired-flag')).resolves.toBe(false)
})
