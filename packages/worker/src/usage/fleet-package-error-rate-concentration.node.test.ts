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
	buildFleetPackageErrorRateConcentrationQuery,
	foldFleetPackageErrorRateConcentrationRows,
	parseFleetPackageErrorRateConcentration,
	resolveFleetPackageErrorRateConcentration,
} = await import('./fleet-package-error-rate-concentration.ts')
const {
	classifyFleetPackageErrorRateConcentrationKind,
	formatFleetPackageErrorRateConcentration,
} = await import('#universal/fleet-package-error-rate-concentration.ts')

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

	const folded = foldFleetPackageErrorRateConcentrationRows([
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
		{ user_id: 'quiet-user', entity_id: 'pkg-quiet', error_count: 2 },
	])
	expect(folded.recentErrors).toBe(92)
	expect(folded.ownerCount).toBe(2)
	expect(folded.packageCount).toBe(4)
	expect(folded.topOwnerShare).toBeCloseTo(90 / 92)
	expect(folded.ranked[0]).toMatchObject({
		ownerId: 'jett-user',
		errors: 90,
		entityIds: [
			jettPackageIds.dji,
			jettPackageIds.earth,
			jettPackageIds.analysis,
		],
	})

	const query = buildFleetPackageErrorRateConcentrationQuery({
		dataset: 'kody_usage_events',
		recentStart: new Date('2026-09-01T00:00:00.000Z'),
		recentEnd: new Date('2026-09-01T01:00:00.000Z'),
	})
	expect(query).toContain('blob1 AS user_id')
	expect(query).toContain('GROUP BY user_id, entity_id')
	expect(query).toContain("blob4 = 'error'")

	queryAnalyticsEngineSql.mockResolvedValueOnce([
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
	])
	const concentration = await resolveFleetPackageErrorRateConcentration({
		env: {
			APP_DB: createConcentrationDb(),
			CLOUDFLARE_ACCOUNT_ID: 'account',
			CLOUDFLARE_API_TOKEN: 'token',
		},
		dataset: 'kody_usage_events',
		recentStart: new Date('2026-09-01T00:00:00.000Z'),
		recentEnd: new Date('2026-09-01T01:00:00.000Z'),
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
	expect(formatFleetPackageErrorRateConcentration(concentration!)).toBe(
		'One account owns 100% of recent errors (jett: dji-cloud-relay-staging-deploy, earthranger-relay-staging-deploy, analysis-staging-deploy).',
	)
	expect(JSON.stringify(concentration)).not.toContain('user_id')
	expect(JSON.stringify(concentration)).not.toContain('jett-user')
	expect(JSON.stringify(concentration)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)

	queryAnalyticsEngineSql.mockResolvedValueOnce([
		{ user_id: 'user-a', entity_id: 'pkg-a', error_count: 20 },
		{ user_id: 'user-b', entity_id: 'pkg-b', error_count: 20 },
		{ user_id: 'user-c', entity_id: 'pkg-c', error_count: 20 },
		{ user_id: 'user-d', entity_id: 'pkg-d', error_count: 20 },
		{ user_id: 'user-e', entity_id: 'pkg-e', error_count: 20 },
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
	})
	expect(fleet).toMatchObject({
		kind: 'fleet',
		owner_count: 5,
		owners: [],
	})
	expect(formatFleetPackageErrorRateConcentration(fleet!)).toBe(
		'Errors are spread across the fleet (top owner 20%).',
	)

	expect(
		formatFleetPackageErrorRateConcentration({
			kind: 'few_accounts',
			recent_errors: 100,
			owner_count: 3,
			package_count: 3,
			top_owner_share: 0.4,
			owners: [
				{
					username: 'ada',
					error_share: 0.4,
					packages: [{ kody_id: 'ada-relay' }],
				},
				{
					username: 'bea',
					error_share: 0.3,
					packages: [{ kody_id: 'bea-relay' }],
				},
			],
		}),
	).toBe(
		'A few accounts own most recent errors (top owner 40%: ada: ada-relay; bea: bea-relay).',
	)

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
