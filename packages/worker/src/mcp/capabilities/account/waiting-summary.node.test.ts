import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { waitingSummaryCapability } from './waiting-summary.ts'

function createWaitingTestDb(input: {
	email: string
	emailVerified: boolean
	missingUser?: boolean
	dismissedOnboarding?: boolean
}) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	return {
		stableUserId,
		db: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind(...params: Array<unknown>) {
						return {
							async first<T>() {
								if (input.missingUser) return null
								if (
									normalized.includes('from users') &&
									normalized.includes('email_verified_at')
								) {
									return {
										id: 11,
										email_verified_at: input.emailVerified
											? '2026-01-01 00:00:00'
											: null,
									} as T
								}
								if (
									normalized.includes('from users') &&
									normalized.includes('onboarding_checklist_dismissed_at')
								) {
									return {
										onboarding_checklist_dismissed_at: input.dismissedOnboarding
											? '2026-01-02 00:00:00'
											: null,
									} as T
								}
								void params
								return null
							},
							async all() {
								return { results: [] }
							},
						}
					},
				}
			},
		} as unknown as D1Database,
	}
}

test('waitingSummary requires auth and stays self-scoped', async () => {
	const email = 'waiting-summary@example.com'
	const { stableUserId, db } = createWaitingTestDb({
		email,
		emailVerified: true,
		dismissedOnboarding: true,
	})
	const env = { APP_DB: db } as Env
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com/',
		user: { userId: stableUserId, email, displayName: 'Waiting' },
	})

	await expect(
		waitingSummaryCapability.handler(
			{},
			{
				env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com/',
				}),
			},
		),
	).rejects.toThrow(/Authenticated MCP user/)

	const empty = await waitingSummaryCapability.handler(
		{},
		{ env, callerContext },
	)
	expect(empty).toEqual({
		count: 0,
		waiting_url: 'https://example.com/account/waiting',
		items: [],
	})

	const unverifiedDb = createWaitingTestDb({
		email,
		emailVerified: false,
		dismissedOnboarding: true,
	})
	const unverified = await waitingSummaryCapability.handler(
		{},
		{
			env: { APP_DB: unverifiedDb.db } as Env,
			callerContext,
		},
	)
	expect(unverified.count).toBe(1)
	expect(unverified.items[0]).toMatchObject({
		id: 'verify-email',
		kind: 'verify-email',
		who: 'you',
		do_label: 'Verify email',
		href: 'https://example.com/pending-verification',
		severity: 'block',
	})

	const missing = await waitingSummaryCapability.handler(
		{},
		{
			env: {
				APP_DB: createWaitingTestDb({
					email,
					emailVerified: true,
					missingUser: true,
				}).db,
			} as Env,
			callerContext,
		},
	)
	expect(missing).toEqual({
		count: 0,
		waiting_url: 'https://example.com/account/waiting',
		items: [],
	})
})
