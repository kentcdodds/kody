import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as cloudflareEmail from '#app/email/cloudflare-email.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'
import type * as runRecordsService from '#worker/run-records/service.ts'
import { type RunRecord } from '#worker/run-records/types.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const sendCloudflareEmail = vi.fn<typeof cloudflareEmail.sendCloudflareEmail>(
	async () => ({ ok: true }),
)

vi.mock('#app/email/cloudflare-email.ts', () => ({
	sendCloudflareEmail: (
		...args: Parameters<typeof cloudflareEmail.sendCloudflareEmail>
	) => sendCloudflareEmail(...args),
}))

const listRunRecords = vi.fn<typeof runRecordsService.listRunRecords>(
	async () => ({ runs: [], nextCursor: null }),
)

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (
		...args: Parameters<typeof runRecordsService.listRunRecords>
	) => listRunRecords(...args),
}))

const getSavedPackageByIdInAnyOrg = vi.fn<
	typeof packageRepo.getSavedPackageByIdInAnyOrg
>(async () => null)

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: (
		...args: Parameters<typeof packageRepo.getSavedPackageByIdInAnyOrg>
	) => getSavedPackageByIdInAnyOrg(...args),
}))

const {
	sendUserErrorRateEmails,
	shouldSendUserErrorRateEmail,
	summarizeRunError,
	userErrorRateEmailKvKey,
	userErrorRateMinErrors,
} = await import('#app/user-error-rate-emails.ts')

function errorRun(overrides: Partial<RunRecord>): RunRecord {
	return {
		id: 'run-0',
		surface: 'webhook',
		status: 'error',
		name: null,
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-08-14T00:00:00.000Z',
		finishedAt: '2026-08-14T00:00:01.000Z',
		durationMs: 1000,
		errorName: 'Error',
		errorMessage: 'boom',
		errorTriage: null,
		triageNote: null,
		triagedAt: null,
		triagedBy: null,
		metadata: {},
		logCount: 0,
		...overrides,
	}
}

function createKv() {
	const store = new Map<string, string>()
	return {
		store,
		kv: {
			async get(key: string) {
				return store.get(key) ?? null
			},
			async put(key: string, value: string) {
				store.set(key, value)
			},
		} as unknown as KVNamespace,
	}
}

function createEnv(input: {
	users: Array<{
		stable_user_id: string
		org_id?: string
		email: string
		event_count: number
		error_count: number
	}>
	kv?: KVNamespace
	onUsageRollupsQuery?: (query: string) => void
}) {
	return {
		APP_DB: {
			prepare(query: string) {
				const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
				return {
					bind() {
						return this
					},
					async all<T>() {
						if (normalized.includes('from usage_rollups')) {
							// Require the JOIN predicate, not only SELECT personal_org_id AS org_id.
							const joinsOnPersonalOrg =
								/inner join users u on coalesce\(nullif\(trim\(u\.personal_org_id\), ''\), u\.stable_user_id\) = r\.user_id/.test(
									normalized,
								)
							if (
								!joinsOnPersonalOrg ||
								/inner join users u on u\.stable_user_id = r\.user_id/.test(
									normalized,
								)
							) {
								throw new Error(
									`Error-rate sweep must JOIN users on personalOrgIdSql = r.user_id: ${query}`,
								)
							}
							input.onUsageRollupsQuery?.(query)
							return {
								results: input.users.map((user) => ({
									...user,
									org_id: user.org_id ?? user.stable_user_id,
								})) as Array<T>,
							}
						}
						return { results: [] }
					},
				}
			},
		} as unknown as D1Database,
		APP_BASE_URL: 'https://kody.codes/',
		CLOUDFLARE_ACCOUNT_ID: 'acct',
		CLOUDFLARE_API_TOKEN: 'token',
		BUNDLE_ARTIFACTS_KV: input.kv,
	} as unknown as Env
}

test('error-rate emails skip below-threshold users and claim once per month', async () => {
	expect(shouldSendUserErrorRateEmail({ errorCount: 4, eventCount: 10 })).toBe(
		false,
	)
	expect(shouldSendUserErrorRateEmail({ errorCount: 5, eventCount: 30 })).toBe(
		false,
	)
	expect(shouldSendUserErrorRateEmail({ errorCount: 5, eventCount: 25 })).toBe(
		true,
	)
	expect(
		shouldSendUserErrorRateEmail({ errorCount: 10, eventCount: 200 }),
	).toBe(true)

	const { kv, store } = createKv()
	const now = new Date('2026-08-15T12:00:00.000Z')
	const env = createEnv({
		users: [
			{
				stable_user_id: 'user-low',
				email: 'low@example.com',
				event_count: 30,
				error_count: userErrorRateMinErrors,
			},
			{
				stable_user_id: 'user-hot',
				email: 'hot@example.com',
				event_count: 20,
				error_count: 10,
			},
		],
		kv,
	})

	const first = await sendUserErrorRateEmails({ env, now })
	expect(first).toEqual({ status: 'notified', emailedUsers: 1 })
	expect(sendCloudflareEmail).toHaveBeenCalledTimes(1)
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as {
		to: string
		html: string
		text: string
	}
	expect(payload.to).toBe('hot@example.com')
	expect(payload.html).toContain('https://kody.codes/account/activity')
	expect(payload.text).toContain('/support')
	expect(
		store.get(
			userErrorRateEmailKvKey({
				userId: ownerIdFromStored('user-hot'),
				month: '2026-08',
			}),
		),
	).toBeTruthy()

	sendCloudflareEmail.mockClear()
	const again = await sendUserErrorRateEmails({ env, now })
	expect(again).toEqual({ status: 'no_warnings' })
	expect(sendCloudflareEmail).not.toHaveBeenCalled()
})

test('error-rate sweep joins usage rollups by personal org id when distinct from person id', async () => {
	sendCloudflareEmail.mockClear()
	listRunRecords.mockResolvedValueOnce({ runs: [], nextCursor: null })
	const personId = 'person-distinct'
	const orgId = 'org-distinct'
	expect(personId).not.toBe(orgId)
	const { kv, store } = createKv()
	const queries: Array<string> = []
	const result = await sendUserErrorRateEmails({
		env: createEnv({
			users: [
				{
					stable_user_id: personId,
					org_id: orgId,
					email: 'ada@example.com',
					event_count: 20,
					error_count: 10,
				},
			],
			kv,
			onUsageRollupsQuery(query) {
				queries.push(query)
			},
		}),
		now: new Date('2026-08-15T12:00:00.000Z'),
	})
	expect(result).toEqual({ status: 'notified', emailedUsers: 1 })
	expect(queries).toHaveLength(1)
	expect(queries[0]).toMatch(
		/INNER JOIN users u ON COALESCE\(NULLIF\(TRIM\(u\.personal_org_id\), ''\), u\.stable_user_id\) = r\.user_id/,
	)
	expect(queries[0]).not.toMatch(
		/INNER JOIN users u ON u\.stable_user_id = r\.user_id/,
	)
	expect(sendCloudflareEmail.mock.calls[0]?.[1]).toMatchObject({
		to: 'ada@example.com',
	})
	expect(listRunRecords).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored(orgId) }),
	)
	expect(
		store.get(
			userErrorRateEmailKvKey({
				userId: personId,
				month: '2026-08',
			}),
		),
	).toBeTruthy()
})

test('error-rate email names each failing package once with its error and a run link', async () => {
	sendCloudflareEmail.mockClear()
	listRunRecords.mockResolvedValueOnce({
		runs: [
			errorRun({
				id: 'run-newest',
				packageId: 'pkg-review',
				errorMessage:
					'Request refused (credential_placement_refused, slot "token")\n    at stack',
			}),
			errorRun({ id: 'run-older', packageId: 'pkg-review' }),
			errorRun({
				id: 'run-hook',
				name: 'stripe-webhook',
				errorMessage: 'x'.repeat(400),
			}),
			errorRun({ id: 'run-gone', packageId: 'pkg-deleted' }),
			errorRun({ id: 'run-fourth', name: 'nightly' }),
		],
		nextCursor: null,
	})
	getSavedPackageByIdInAnyOrg.mockImplementation(async (_db, packageId) =>
		packageId === 'pkg-review'
			? ({ id: packageId, name: 'review-ticket' } as SavedPackageRecord)
			: null,
	)
	const { kv } = createKv()
	const result = await sendUserErrorRateEmails({
		env: createEnv({
			users: [
				{
					stable_user_id: 'user-named',
					email: 'named@example.com',
					event_count: 20,
					error_count: 10,
				},
			],
			kv,
		}),
		now: new Date('2026-08-15T12:00:00.000Z'),
	})

	expect(result).toEqual({ status: 'notified', emailedUsers: 1 })
	expect(listRunRecords).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-named'),
			filter: {
				status: 'error',
				since: '2026-08-01T00:00:00.000Z',
				errorTriage: 'open',
			},
		}),
	)
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as { text: string }
	expect(payload.text).toContain(
		'Package review-ticket failed: Request refused (credential_placement_refused, slot "token") Open the run: https://kody.codes/account/activity/run-newest',
	)
	expect(payload.text).not.toContain('run-older')
	expect(payload.text).not.toContain('at stack')
	expect(payload.text).toContain(
		`stripe-webhook failed: ${'x'.repeat(239)}… Open the run: https://kody.codes/account/activity/run-hook`,
	)
	expect(payload.text).toContain(
		'A run failed: boom Open the run: https://kody.codes/account/activity/run-gone',
	)
	expect(payload.text).not.toContain('nightly')
})

test('error-rate email still sends the count when the run log is unavailable', async () => {
	sendCloudflareEmail.mockClear()
	listRunRecords.mockRejectedValueOnce(new Error('run log down'))
	consoleWarn.mockImplementation(() => {})
	const { kv } = createKv()
	const result = await sendUserErrorRateEmails({
		env: createEnv({
			users: [
				{
					stable_user_id: 'user-degraded',
					email: 'degraded@example.com',
					event_count: 20,
					error_count: 10,
				},
			],
			kv,
		}),
		now: new Date('2026-08-15T12:00:00.000Z'),
	})
	expect(result).toEqual({ status: 'notified', emailedUsers: 1 })
	const payload = sendCloudflareEmail.mock.calls[0]?.[1] as { text: string }
	expect(payload.text).toContain('10 errors across 20 runs')
	expect(payload.text).not.toContain('failed:')
	expect(consoleWarn).toHaveBeenCalledWith(
		'user-error-rate-email-runs-failed',
		expect.any(Error),
	)
})

test('summarizeRunError keeps the first non-empty line and redacts Kody tokens', () => {
	expect(summarizeRunError({ errorMessage: '  first\nsecond' })).toBe('first')
	expect(summarizeRunError({ errorMessage: '\n  \nactual error\nmore' })).toBe(
		'actual error',
	)
	const token = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const redacted = summarizeRunError({
		errorMessage: `Unauthorized with ${token}`,
	})
	expect(redacted).toBe('Unauthorized with kody_at_[redacted]')
	expect(redacted).not.toContain('B'.repeat(43))
})
