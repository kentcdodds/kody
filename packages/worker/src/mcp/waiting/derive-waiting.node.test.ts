import { expect, test, vi } from 'vitest'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { accountActivitySummaryWindowMs } from '#universal/account-activity-filters.ts'
import { buildWaitingItems } from '#universal/waiting.ts'
import { collectWaitingSignals } from './derive-waiting.ts'

const mockModule = vi.hoisted(() => ({
	summarizeRunRecords: vi.fn(async () => ({
		since: new Date(0).toISOString(),
		total: 0,
		errors: 0,
		ignored: 0,
		resolved: 0,
		running: 0,
		bySurface: [],
	})),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	summarizeRunRecords: (...args: Array<unknown>) =>
		mockModule.summarizeRunRecords(...args),
}))

function createStubDb() {
	return {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							return null
						},
						async all() {
							return { results: [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

const user = {
	userId: 11,
	stableUserId: 'user-aaa',
	email: 'waiting@example.com',
	username: 'waiting',
	emailVerified: true,
}

test('waiting signals read MCP OAuth grants from OAUTH_KV when the provider helpers are absent', async () => {
	const { kv } = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': JSON.stringify({
			id: 'grant-1',
			userId: 'user-aaa',
			clientId: 'host-client',
			scope: ['mcp'],
		}),
		'grant:user-bbb:grant-2': JSON.stringify({
			id: 'grant-2',
			userId: 'user-bbb',
			clientId: 'host-client',
			scope: ['mcp'],
		}),
	})
	const connected = await collectWaitingSignals({
		env: { APP_DB: createStubDb(), OAUTH_KV: kv } as Env,
		user,
	})
	expect(connected.onboardingRemaining).not.toContain('connect-agent')

	const disconnected = await collectWaitingSignals({
		env: { APP_DB: createStubDb(), OAUTH_KV: kv } as Env,
		user: { ...user, stableUserId: 'user-ccc' },
	})
	expect(disconnected.onboardingRemaining).toContain('connect-agent')

	const noOAuthSurface = await collectWaitingSignals({
		env: { APP_DB: createStubDb() } as Env,
		user,
	})
	expect(noOAuthSurface.onboardingRemaining).toContain('connect-agent')
})

test('waiting error-rate card uses open Activity errors, not monthly rollups', async () => {
	const now = new Date('2026-09-05T00:00:00.000Z')
	const env = { APP_DB: createStubDb() } as Env

	mockModule.summarizeRunRecords.mockResolvedValueOnce({
		since: new Date(
			now.getTime() - accountActivitySummaryWindowMs,
		).toISOString(),
		total: 162103,
		errors: 0,
		ignored: 800,
		resolved: 407,
		running: 0,
		bySurface: [],
	})
	const triaged = await collectWaitingSignals({ env, user, now })
	expect(mockModule.summarizeRunRecords).toHaveBeenCalledWith({
		env,
		userId: user.stableUserId,
		since: new Date(
			now.getTime() - accountActivitySummaryWindowMs,
		).toISOString(),
	})
	expect(triaged.errorRate).toEqual({ errorCount: 0, eventCount: 162103 })
	expect(buildWaitingItems(triaged).map((item) => item.kind)).not.toContain(
		'error-rate',
	)

	mockModule.summarizeRunRecords.mockResolvedValueOnce({
		since: new Date(
			now.getTime() - accountActivitySummaryWindowMs,
		).toISOString(),
		total: 20,
		errors: 12,
		ignored: 0,
		resolved: 0,
		running: 0,
		bySurface: [],
	})
	const open = await collectWaitingSignals({ env, user, now })
	expect(open.errorRate).toEqual({ errorCount: 12, eventCount: 20 })
	expect(
		buildWaitingItems(open).find((item) => item.id === 'error-rate'),
	).toEqual(
		expect.objectContaining({
			title: 'Error rate is elevated',
			href: '/account/activity',
		}),
	)
})
