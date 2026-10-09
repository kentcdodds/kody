import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createInMemoryRepoSessionIndexEnv } from '#worker/test-support/repo-session-index.ts'
import { createInMemoryRunLogUsageEnv } from '#worker/test-support/run-log-usage.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { usageGetCapability } from './usage-get.ts'

const email = 'usage-get@example.com'

function createUsageEnv(input: {
	plan: string
	stripePlan?: string
	entitlementLadder?: 'legacy'
	packageCount?: number
	uniqueWorkerDays?: number
}) {
	const stableUserId = testStableUserIdFromEmail(email)
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	applyAllMigrations(
		sqlite,
		new URL('../../../../../jobs-worker/migrations/', import.meta.url),
	)
	sqlite
		.prepare(
			`INSERT INTO users (username, email, password_hash, stable_user_id, plan, stripe_plan, entitlement_ladder)
			 VALUES ('usage', ?, 'hash', ?, ?, ?, ?)`,
		)
		.run(
			email,
			stableUserId,
			input.plan,
			input.stripePlan ?? null,
			input.entitlementLadder ?? 'public',
		)
	for (let index = 0; index < (input.packageCount ?? 0); index += 1) {
		sqlite
			.prepare(
				`INSERT INTO saved_packages (id, user_id, name, kody_id, description, source_id)
				 VALUES (?, ?, ?, ?, '', ?)`,
			)
			.run(
				`pkg-${index}`,
				stableUserId,
				`pkg-${index}`,
				`pkg-${index}`,
				`src-${index}`,
			)
	}
	if (input.uniqueWorkerDays) {
		sqlite
			.prepare(
				`INSERT INTO usage_rollups (user_id, metric, month, event_count)
				 VALUES (?, 'dynamic_worker_day', ?, ?)`,
			)
			.run(stableUserId, utcMonthKey(new Date()), input.uniqueWorkerDays)
	}
	const db = createD1FromSqlite(sqlite)
	return {
		APP_DB: db,
		...createInMemoryUserMeterEnv().env,
		...createInMemoryRunLogUsageEnv().env,
		REPO_SESSION_INDEX:
			createInMemoryRepoSessionIndexEnv(db).REPO_SESSION_INDEX,
		MAILBOX: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ countMessages: async () => ({ total: 0 }) }),
		},
	} as unknown as Env
}

async function readUsage(input: Parameters<typeof createUsageEnv>[0]) {
	const result = await usageGetCapability.handler(
		{},
		{
			env: createUsageEnv(input),
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://example.com',
				user: {
					userId: personIdFromStored(testStableUserIdFromEmail(email)),
					email,
					displayName: 'Usage',
				},
			}),
		},
	)
	expect(result.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/)
	return {
		result,
		resource: (name: string) =>
			result.resources.find((row) => row.resource === name),
	}
}

test('usageGet returns self-scoped entitlement snapshot', async () => {
	await expect(
		usageGetCapability.handler(
			{},
			{
				env: createUsageEnv({ plan: 'pro' }),
				callerContext: createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow(/Authenticated MCP user/)

	const { result, resource } = await readUsage({ plan: 'pro', packageCount: 1 })
	expect(result.plan).toBe('pro')
	expect(resource('unique_worker_days')).toMatchObject({
		label: 'Worker compute',
		group: 'monthly',
		current: 0,
		limit: 2_000,
		overEightyPercent: false,
	})
	expect(resource('durable_object_rows_read')).toMatchObject({
		label: 'Rows read',
		group: 'monthly',
		current: 0,
		limit: 20_000_000_000,
		overEightyPercent: false,
	})
	expect(resource('saved_packages')?.current).toBe(1)
	expect(resource('saved_packages')?.limit).toBeGreaterThan(0)
	expect(resource('execute_calls_per_day')?.limit).toBe(1_500)
	expect(resource('execute_calls_per_day')?.week).toEqual({
		current: 0,
		limit: 4_000,
		percent: 0,
		overEightyPercent: false,
	})
})

test('usageGet reports legacy Standard ceilings for grandfathered accounts', async () => {
	const { result, resource } = await readUsage({
		plan: 'free',
		stripePlan: 'standard',
		entitlementLadder: 'legacy',
	})
	expect(result.plan).toBe('standard')
	expect(resource('execute_calls_per_day')?.limit).toBe(500)
	expect(resource('execute_calls_per_day')?.week).toBeUndefined()
})

test('usageGet lists Free Worker compute as informational, never as a warning', async () => {
	const { result, resource } = await readUsage({
		plan: 'free',
		uniqueWorkerDays: 517,
	})
	expect(resource('unique_worker_days')).toMatchObject({
		label: 'Worker compute',
		current: 517,
		limit: 50,
		howToReduce: expect.stringContaining(
			'On Free this is informational: it never charges you or stops runs. Execute caps are your limit.',
		),
	})
	expect(
		result.warnings.some((row) => row.resource === 'unique_worker_days'),
	).toBe(false)
})
