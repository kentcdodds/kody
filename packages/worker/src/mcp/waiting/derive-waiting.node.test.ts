import { expect, test, vi } from 'vitest'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { accountActivitySummaryWindowMs } from '#universal/account-activity-filters.ts'
import { buildWaitingItems, waitingFirstUseIds } from '#universal/waiting.ts'
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
	listJoinedIntegrations: vi.fn(async () => []),
	listSecrets: vi.fn(async () => []),
	listSavedPackagesByUserId: vi.fn(async () => []),
	listMemoriesByUserId: vi.fn(async () => []),
	countJobsForUser: vi.fn(async () => 0),
	readOfficialDiscordMembershipForUser: vi.fn(async () => false),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	summarizeRunRecords: (...args: Array<unknown>) =>
		mockModule.summarizeRunRecords(...args),
}))

vi.mock('#worker/integrations/service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/integrations/service.ts')>()
	return {
		...actual,
		listJoinedIntegrations: (...args: Array<unknown>) =>
			mockModule.listJoinedIntegrations(...args),
	}
})

vi.mock('#mcp/secrets/service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#mcp/secrets/service.ts')>()
	return {
		...actual,
		listSecrets: (...args: Array<unknown>) => mockModule.listSecrets(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#mcp/memory/repo.ts', () => ({
	listMemoriesByUserId: (...args: Array<unknown>) =>
		mockModule.listMemoriesByUserId(...args),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		countJobsForUser: (...args: Array<unknown>) =>
			mockModule.countJobsForUser(...args),
	}),
}))

vi.mock('#worker/discord/guild-membership.ts', () => ({
	readOfficialDiscordMembershipForUser: (...args: Array<unknown>) =>
		mockModule.readOfficialDiscordMembershipForUser(...args),
}))

function createStubDb(stamps?: {
	first_search_at?: string | null
	first_execute_at?: string | null
	first_saved_package_at?: string | null
	onboarding_checklist_dismissed_at?: string | null
}) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind() {
					return {
						async first() {
							if (!stamps) return null
							if (normalized.includes('first_search_at')) {
								return { first_search_at: stamps.first_search_at ?? null }
							}
							if (normalized.includes('first_execute_at')) {
								return { first_execute_at: stamps.first_execute_at ?? null }
							}
							if (normalized.includes('first_saved_package_at')) {
								return {
									first_saved_package_at: stamps.first_saved_package_at ?? null,
								}
							}
							if (normalized.includes('onboarding_checklist_dismissed_at')) {
								return {
									onboarding_checklist_dismissed_at:
										stamps.onboarding_checklist_dismissed_at ?? null,
								}
							}
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

function resetFirstUseMocks() {
	mockModule.listJoinedIntegrations.mockReset()
	mockModule.listJoinedIntegrations.mockResolvedValue([])
	mockModule.listSecrets.mockReset()
	mockModule.listSecrets.mockResolvedValue([])
	mockModule.listSavedPackagesByUserId.mockReset()
	mockModule.listSavedPackagesByUserId.mockResolvedValue([])
	mockModule.listMemoriesByUserId.mockReset()
	mockModule.listMemoriesByUserId.mockResolvedValue([])
	mockModule.countJobsForUser.mockReset()
	mockModule.countJobsForUser.mockResolvedValue(0)
	mockModule.readOfficialDiscordMembershipForUser.mockReset()
	mockModule.readOfficialDiscordMembershipForUser.mockResolvedValue(false)
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

test('waiting first-use signals emit cards only when the probe knows they are missing', async () => {
	resetFirstUseMocks()
	const env = {
		APP_DB: createStubDb({
			first_search_at: null,
			first_execute_at: null,
			first_saved_package_at: null,
			onboarding_checklist_dismissed_at: '2026-09-01T00:00:00.000Z',
		}),
	} as Env

	const missing = await collectWaitingSignals({ env, user })
	expect(missing.firstUseMissing).toEqual([...waitingFirstUseIds])
	expect(buildWaitingItems(missing).map((item) => item.id)).toEqual(
		waitingFirstUseIds.map((id) => `first-use:${id}`),
	)
	expect(missing.onboardingDismissed).toBe(true)

	mockModule.listMemoriesByUserId.mockResolvedValueOnce([
		{ id: 'mem-1', subject: 'Commute' },
	])
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([
		{ id: 'pkg-1', name: 'demo', kodyId: 'demo', lockedAt: null },
	])
	mockModule.countJobsForUser.mockResolvedValueOnce(1)
	mockModule.listJoinedIntegrations.mockResolvedValueOnce([
		{ connection: { name: 'github', lastAuthFailure: null } },
	])
	mockModule.listSecrets.mockResolvedValueOnce([{ name: 'apiKey', ttlMs: 60 }])
	mockModule.readOfficialDiscordMembershipForUser.mockResolvedValueOnce(true)
	const present = await collectWaitingSignals({
		env: {
			APP_DB: createStubDb({
				first_search_at: '2026-09-01T00:00:00.000Z',
				first_execute_at: '2026-09-01T00:00:00.000Z',
				first_saved_package_at: '2026-09-01T00:00:00.000Z',
				onboarding_checklist_dismissed_at: '2026-09-01T00:00:00.000Z',
			}),
		} as Env,
		user,
	})
	expect(present.firstUseMissing).toEqual([])
	expect(
		buildWaitingItems(present).filter((item) => item.kind === 'first-use'),
	).toEqual([])

	mockModule.listMemoriesByUserId.mockRejectedValueOnce(new Error('d1 blip'))
	mockModule.countJobsForUser.mockRejectedValueOnce(new Error('jobs down'))
	mockModule.listJoinedIntegrations.mockRejectedValueOnce(
		new Error('integrations down'),
	)
	mockModule.listSecrets.mockRejectedValueOnce(new Error('secrets down'))
	mockModule.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('packages down'),
	)
	mockModule.readOfficialDiscordMembershipForUser.mockResolvedValueOnce(null)
	const unknown = await collectWaitingSignals({
		env: { APP_DB: createStubDb() } as Env,
		user,
	})
	expect(unknown.firstUseMissing).toEqual([])

	resetFirstUseMocks()
	mockModule.listMemoriesByUserId.mockResolvedValue([{ id: 'mem-1' }])
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		{ id: 'pkg-1', name: 'demo', kodyId: 'demo', lockedAt: null },
	])
	mockModule.countJobsForUser.mockResolvedValue(1)
	mockModule.listJoinedIntegrations.mockResolvedValue([
		{ connection: { name: 'github', lastAuthFailure: null } },
	])
	mockModule.listSecrets.mockResolvedValue([{ name: 'apiKey', ttlMs: 60 }])
	mockModule.readOfficialDiscordMembershipForUser.mockResolvedValue(false)
	const discordOpen = await collectWaitingSignals({
		env: {
			APP_DB: createStubDb({
				first_search_at: '2026-09-01T00:00:00.000Z',
				first_execute_at: '2026-09-01T00:00:00.000Z',
				first_saved_package_at: '2026-09-01T00:00:00.000Z',
				onboarding_checklist_dismissed_at: '2026-09-01T00:00:00.000Z',
			}),
		} as Env,
		user,
	})
	expect(discordOpen.firstUseMissing).toEqual(['discord'])
	expect(buildWaitingItems(discordOpen).map((item) => item.id)).toEqual([
		'first-use:discord',
	])
	resetFirstUseMocks()
})
