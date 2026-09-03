import { expect, test, vi } from 'vitest'

const queryAnalyticsEngineSql = vi.fn()

vi.mock('./aggregate-rollups.ts', async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>
	return {
		...original,
		queryAnalyticsEngineSql: (...args: Array<unknown>) =>
			queryAnalyticsEngineSql(...args),
	}
})

const {
	buildFleetPackageErrorRateConcentrationPackageQuery,
	buildFleetPackageErrorRateConcentrationQuery,
	foldFleetPackageErrorRateConcentrationRows,
	parseFleetPackageErrorRateConcentration,
	resolveFleetPackageErrorRateConcentration,
} = await import('./fleet-package-error-rate-concentration.ts')
const { classifyFleetPackageErrorRateConcentrationKind } =
	await import('#universal/fleet-package-error-rate-concentration.ts')

const jettPackageIds = {
	dji: '11111111-1111-4111-8111-111111111111',
	earth: '22222222-2222-4222-8222-222222222222',
	analysis: '33333333-3333-4333-8333-333333333333',
} as const

function createConcentrationDb(
	input: {
		users?: Array<{ stable_user_id: string; username: string }>
		packages?: Array<{ id: string; kody_id: string }>
	} = {},
) {
	const users = input.users ?? [
		{ stable_user_id: 'jett-user', username: 'jett' },
	]
	const packages = input.packages ?? [
		{ id: jettPackageIds.dji, kody_id: 'dji-cloud-relay-staging-deploy' },
		{
			id: jettPackageIds.earth,
			kody_id: 'earthranger-relay-staging-deploy',
		},
		{ id: jettPackageIds.analysis, kody_id: 'analysis-staging-deploy' },
	]
	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all() {
							if (query.includes('FROM users')) {
								return {
									results: users.filter((user) =>
										params.includes(user.stable_user_id),
									),
								}
							}
							if (query.includes('FROM saved_packages')) {
								return {
									results: packages.filter((pkg) => params.includes(pkg.id)),
								}
							}
							return { results: [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('fleet package error-rate concentration classifies, names, and stays identifier-safe', async () => {
	expect(
		classifyFleetPackageErrorRateConcentrationKind({
			topOwnerShare: 0.8,
			topFewShare: 0.8,
		}),
	).toBe('one_account')
	expect(
		classifyFleetPackageErrorRateConcentrationKind({
			topOwnerShare: 0.5,
			topFewShare: 0.85,
		}),
	).toBe('few_accounts')
	expect(
		classifyFleetPackageErrorRateConcentrationKind({
			topOwnerShare: 0.3,
			topFewShare: 0.6,
		}),
	).toBe('fleet')

	const folded = foldFleetPackageErrorRateConcentrationRows(
		[
			{ user_id: 'jett-user', error_count: 90 },
			{ user_id: 'quiet-user', error_count: 2 },
		],
		92,
	)
	expect(folded.recentErrors).toBe(92)
	expect(folded.ownerCount).toBe(2)
	expect(folded.topOwnerShare).toBeCloseTo(90 / 92)
	const truncatedFleet = foldFleetPackageErrorRateConcentrationRows(
		Array.from({ length: 50 }, (_, index) => ({
			user_id: `user-${index}`,
			entity_id: `pkg-${index}`,
			error_count: 1,
		})),
		200,
	)
	expect(truncatedFleet.topOwnerShare).toBe(1 / 200)
	expect(
		classifyFleetPackageErrorRateConcentrationKind({
			topOwnerShare: truncatedFleet.topOwnerShare,
			topFewShare: truncatedFleet.topFewShare,
		}),
	).toBe('fleet')
	expect(folded.ranked[0]).toMatchObject({
		ownerId: 'jett-user',
		errors: 90,
		entityIds: [],
	})

	const query = buildFleetPackageErrorRateConcentrationQuery({
		dataset: 'kody_usage_events',
		recentStart: new Date('2026-09-01T00:00:00.000Z'),
		recentEnd: new Date('2026-09-01T01:00:00.000Z'),
	})
	expect(query).toContain('blob1 AS user_id')
	expect(query).toContain('GROUP BY user_id')
	expect(query).not.toContain('GROUP BY user_id, entity_id')
	expect(query).toContain("blob4 = 'error'")
	const packageQuery = buildFleetPackageErrorRateConcentrationPackageQuery({
		dataset: 'kody_usage_events',
		recentStart: new Date('2026-09-01T00:00:00.000Z'),
		recentEnd: new Date('2026-09-01T01:00:00.000Z'),
		ownerIds: ['jett-user'],
	})
	expect(packageQuery).toContain("blob1 IN ('jett-user')")
	expect(packageQuery).toContain('GROUP BY user_id, entity_id')
	expect(packageQuery).toContain('LIMIT 5')

	queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			if (input.query.includes('GROUP BY user_id, entity_id')) {
				return [
					{
						user_id: 'jett-user',
						entity_id: jettPackageIds.dji,
						error_count: 40,
					},
					{
						user_id: 'jett-user',
						entity_id: jettPackageIds.earth,
						error_count: 30,
					},
					{
						user_id: 'jett-user',
						entity_id: jettPackageIds.analysis,
						error_count: 20,
					},
				]
			}
			return [{ user_id: 'jett-user', error_count: 90 }]
		},
	)
	const concentration = await resolveFleetPackageErrorRateConcentration({
		env: {
			APP_DB: createConcentrationDb(),
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		dataset: 'kody_usage_events',
		recentStart: new Date('2026-09-01T00:00:00.000Z'),
		recentEnd: new Date('2026-09-01T01:00:00.000Z'),
		recentErrors: 90,
	})
	expect(concentration).toEqual({
		kind: 'one_account',
		recent_errors: 90,
		owner_count: 1,
		package_count: 3,
		top_owner_share: 1,
		owners: [
			{
				username: 'jett',
				error_share: 1,
				packages: [
					{ kody_id: 'dji-cloud-relay-staging-deploy' },
					{ kody_id: 'earthranger-relay-staging-deploy' },
					{ kody_id: 'analysis-staging-deploy' },
				],
			},
		],
	})
	expect(JSON.stringify(concentration)).not.toContain('user_id')
	expect(JSON.stringify(concentration)).not.toContain('jett-user')
	expect(JSON.stringify(concentration)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)

	queryAnalyticsEngineSql.mockImplementation(async () => [
		{ user_id: 'user-a', error_count: 20 },
		{ user_id: 'user-b', error_count: 20 },
		{ user_id: 'user-c', error_count: 20 },
		{ user_id: 'user-d', error_count: 20 },
		{ user_id: 'user-e', error_count: 20 },
	])
	const fleet = await resolveFleetPackageErrorRateConcentration({
		env: {
			APP_DB: createConcentrationDb({
				users: [
					{ stable_user_id: 'user-a', username: 'ada' },
					{ stable_user_id: 'user-b', username: 'bea' },
				],
			}),
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		dataset: 'kody_usage_events',
		recentStart: new Date('2026-09-01T00:00:00.000Z'),
		recentEnd: new Date('2026-09-01T01:00:00.000Z'),
		recentErrors: 100,
	})
	expect(fleet).toMatchObject({
		kind: 'fleet',
		owner_count: 5,
		owners: [],
	})
	queryAnalyticsEngineSql.mockImplementation(
		async (input: { query: string }) => {
			if (input.query.includes("blob1 IN ('user-a')")) {
				return Array.from({ length: 5 }, (_, index) => ({
					user_id: 'user-a',
					entity_id: `pkg-a-${index}`,
					error_count: 10 - index,
				}))
			}
			if (input.query.includes("blob1 IN ('user-b')")) {
				return [{ user_id: 'user-b', entity_id: 'pkg-b', error_count: 1 }]
			}
			return [
				{ user_id: 'user-a', error_count: 50 },
				{ user_id: 'user-b', error_count: 40 },
			]
		},
	)
	const few = await resolveFleetPackageErrorRateConcentration({
		env: {
			APP_DB: createConcentrationDb({
				users: [
					{ stable_user_id: 'user-a', username: 'ada' },
					{ stable_user_id: 'user-b', username: 'bea' },
				],
				packages: [
					{ id: 'pkg-a-0', kody_id: 'ada-relay' },
					{ id: 'pkg-b', kody_id: 'bea-relay' },
				],
			}),
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		dataset: 'kody_usage_events',
		recentStart: new Date('2026-09-01T00:00:00.000Z'),
		recentEnd: new Date('2026-09-01T01:00:00.000Z'),
		recentErrors: 100,
	})
	expect(few).toMatchObject({
		kind: 'few_accounts',
		owners: [
			{ username: 'ada', packages: [{ kody_id: 'ada-relay' }] },
			{ username: 'bea', packages: [{ kody_id: 'bea-relay' }] },
		],
	})

	expect(parseFleetPackageErrorRateConcentration(null)).toBeNull()
	expect(
		parseFleetPackageErrorRateConcentration({
			kind: 'one_account',
			recent_errors: 90,
			owner_count: 1,
			package_count: 3,
			top_owner_share: 1,
			owners: [
				{
					username: 'jett',
					error_share: 1,
					packages: [{ kody_id: 'dji-cloud-relay-staging-deploy' }],
				},
			],
		}),
	).toMatchObject({
		kind: 'one_account',
		owners: [{ username: 'jett' }],
	})
})
