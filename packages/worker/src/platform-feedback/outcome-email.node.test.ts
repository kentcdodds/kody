import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { type PlatformFeedbackRecord } from './types.ts'

const sendCloudflareEmail = vi.fn(async () => ({ ok: true }))

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (...args: Array<unknown>) =>
		sendCloudflareEmail(...args),
}))

const {
	platformFeedbackOutcomeEmailKvKey,
	sendPlatformFeedbackOutcomeEmail,
	shouldSendPlatformFeedbackOutcomeEmail,
} = await import('./outcome-email.ts')

const outcomeEmailClaimTtlSeconds = 30 * 24 * 60 * 60

const feedback: PlatformFeedbackRecord = {
	id: 'feedback-1',
	submitterUserId: 'user-1',
	submitterUsername: 'user-1-name',
	submitterEmail: 'user-1@example.com',
	category: 'friction',
	summary: '</p><script>alert(1)</script>Setup is confusing',
	details: 'The setup flow does not explain the next action.',
	status: 'resolved',
	reviewedByUserId: 'admin-1',
	reviewedAt: '2026-07-19T01:00:00.000Z',
	adminNote: 'platform-feedback-triage shipped: do not mail this',
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T01:00:00.000Z',
}

function createKv() {
	const store = new Map<string, string>()
	const puts: Array<{
		key: string
		value: string
		options?: { expirationTtl?: number }
	}> = []
	return {
		store,
		puts,
		kv: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(
				key: string,
				value: string,
				options?: { expirationTtl?: number },
			) {
				puts.push({ key, value, options })
				store.set(key, value)
			},
			async delete(key: string) {
				store.delete(key)
			},
		} as unknown as KVNamespace,
	}
}

function createUserDb(
	row: {
		email?: string
		suspended_at?: string | null
		email_outbound_paused_at?: string | null
	} | null,
) {
	return {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							if (!row) return null
							return {
								email: row.email ?? 'ada@example.com',
								suspended_at: row.suspended_at ?? null,
								email_outbound_paused_at: row.email_outbound_paused_at ?? null,
							}
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createEnv(input?: { kv?: KVNamespace; db?: D1Database }) {
	return {
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: input?.kv,
		APP_DB: input?.db ?? createUserDb({}),
	} as unknown as Env
}

test('platform feedback outcome emails send once per terminal status, escape summaries, and skip unsafe recipients', async () => {
	expect(
		shouldSendPlatformFeedbackOutcomeEmail({
			didChangeStatus: true,
			status: 'triaged',
		}),
	).toBe(false)
	expect(
		shouldSendPlatformFeedbackOutcomeEmail({
			didChangeStatus: false,
			status: 'resolved',
		}),
	).toBe(false)
	expect(
		shouldSendPlatformFeedbackOutcomeEmail({
			didChangeStatus: true,
			status: 'resolved',
		}),
	).toBe(true)

	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env: createEnv(),
			feedback,
			status: 'resolved',
		}),
	).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const { kv, store, puts } = createKv()
	const env = createEnv({ kv })
	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env,
			feedback,
			status: 'resolved',
		}),
	).toBe(true)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const resolvedPayload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		from: string
		subject: string
		html: string
		text: string
	}
	expect(resolvedPayload.to).toBe('ada@example.com')
	expect(resolvedPayload.from).toBe('kody@kody.codes')
	expect(resolvedPayload.subject).toContain('resolved')
	expect(resolvedPayload.html).not.toContain('<script>')
	expect(resolvedPayload.html).toContain(
		'&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;Setup is confusing',
	)
	expect(resolvedPayload.html).not.toContain(
		'The setup flow does not explain the next action.',
	)
	expect(resolvedPayload.html).not.toContain('platform-feedback-triage shipped')
	expect(resolvedPayload.text).toContain(
		'tell your agent you want to send more Kody feedback',
	)
	expect(
		store.get(
			platformFeedbackOutcomeEmailKvKey({
				feedbackId: 'feedback-1',
				status: 'resolved',
			}),
		),
	).toBeTruthy()
	expect(puts[0]?.options?.expirationTtl).toBe(outcomeEmailClaimTtlSeconds)

	sendCloudflareEmail.mockClear()
	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env,
			feedback,
			status: 'resolved',
			userMessage: 'We shipped a clearer setup path.',
		}),
	).toBe(false)
	expect(sendCloudflareEmail).not.toHaveBeenCalled()

	const dismissed = {
		...feedback,
		id: 'feedback-2',
		status: 'dismissed' as const,
	}
	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env,
			feedback: dismissed,
			status: 'dismissed',
			userMessage: 'We shipped a clearer setup path.',
		}),
	).toBe(true)
	const dismissedPayload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		subject: string
		html: string
		text: string
	}
	expect(dismissedPayload.subject).toContain('update')
	expect(dismissedPayload.html).toContain('We shipped a clearer setup path.')
	expect(dismissedPayload.text).toContain('We shipped a clearer setup path.')
	expect(dismissedPayload.html).toContain(
		'closed it without a product change this time',
	)

	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env: createEnv({ kv, db: createUserDb(null) }),
			feedback: { ...feedback, id: 'feedback-no-user' },
			status: 'resolved',
		}),
	).toBe(false)
	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env: createEnv({
				kv,
				db: createUserDb({ email: '' }),
			}),
			feedback: { ...feedback, id: 'feedback-no-email' },
			status: 'resolved',
		}),
	).toBe(false)
	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env: createEnv({
				kv,
				db: createUserDb({
					email_outbound_paused_at: '2026-07-20T00:00:00.000Z',
				}),
			}),
			feedback: { ...feedback, id: 'feedback-paused' },
			status: 'resolved',
		}),
	).toBe(false)
	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env: createEnv({
				kv,
				db: createUserDb({ suspended_at: '2026-07-20T00:00:00.000Z' }),
			}),
			feedback: { ...feedback, id: 'feedback-suspended' },
			status: 'resolved',
		}),
	).toBe(false)
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
})

test('platform feedback outcome emails reserve the KV claim before sending and release it on send failure', async () => {
	const { kv, store } = createKv()
	const env = createEnv({ kv })
	const order: Array<string> = []
	const originalPut = kv.put.bind(kv)
	kv.put = async (...args: Parameters<KVNamespace['put']>) => {
		order.push('put')
		return originalPut(...args)
	}
	sendCloudflareEmail.mockImplementation(async () => {
		order.push('send')
		throw new Error('smtp down')
	})
	consoleWarn.mockImplementation(() => {})

	expect(
		await sendPlatformFeedbackOutcomeEmail({
			env,
			feedback: { ...feedback, id: 'feedback-claim' },
			status: 'resolved',
		}),
	).toBe(false)
	expect(order).toEqual(['put', 'send'])
	expect(consoleWarn).toHaveBeenCalledWith(
		'platform-feedback-outcome-email-send-failed',
		{
			feedbackId: 'feedback-claim',
			status: 'resolved',
			error: expect.any(Error),
		},
	)
	expect(
		store.get(
			platformFeedbackOutcomeEmailKvKey({
				feedbackId: 'feedback-claim',
				status: 'resolved',
			}),
		),
	).toBeUndefined()
})
