import { expect, test, vi } from 'vitest'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	buildPlatformFeedbackSubmittedEvent,
	platformFeedbackSubmittedTopic,
} from './subscription-event.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(),
	listAdminAccountRows: vi.fn(),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#app/permissions-db.ts', () => ({
	listAdminAccountRows: mocks.listAdminAccountRows,
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

const { dispatchPlatformFeedbackSubmittedSubscriptionEvent } =
	await import('./package-subscriptions.ts')

const openFeedback = {
	id: 'feedback-1',
	submitterUserId: 'submitter-1',
	category: 'friction' as const,
	summary: 'The setup path is confusing',
	details: 'Full feedback details must not enter the subscription payload.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T00:00:00.000Z',
}

function createSavedPackage(input: {
	id: string
	userId: string
	sourceId: string
}) {
	return {
		id: input.id,
		userId: input.userId,
		name: `@admin/${input.id}`,
		kodyId: input.id,
		description: `${input.id} notifier`,
		tags: [],
		searchText: null,
		sourceId: input.sourceId,
		hasApp: false,
		hidden: false,
		createdAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
	}
}

function createManifest(packageId: string, subscribed = true) {
	return {
		manifest: {
			name: `@admin/${packageId}`,
			exports: { '.': './src/index.ts' },
			kody: {
				id: packageId,
				description: `${packageId} notifier`,
				...(subscribed
					? {
							subscriptions: {
								[platformFeedbackSubmittedTopic]: {
									handler: './src/on-platform-feedback.ts',
								},
							},
						}
					: {}),
			},
		},
	}
}

test('platform feedback submitted payload is exact and opaque', () => {
	const payload = buildPlatformFeedbackSubmittedEvent(openFeedback)

	expect(payload).toEqual({
		event: 'platform.feedback.submitted',
		feedback: {
			id: 'feedback-1',
			category: 'friction',
			status: 'open',
			created_at: '2026-07-19T00:00:00.000Z',
		},
	})
	expect(Object.keys(payload.feedback).sort()).toEqual(
		['category', 'created_at', 'id', 'status'].sort(),
	)
	expect(payload.feedback).not.toHaveProperty('submitter_user_id')
	expect(payload.feedback).not.toHaveProperty('summary_untrusted')
	expect(payload.feedback).not.toHaveProperty('details')
	expect(payload.feedback).not.toHaveProperty('admin_note')
	expect(payload.feedback).not.toHaveProperty('reviewed_by_user_id')
	expect(payload).not.toHaveProperty('content_warning')
	expect(payload).not.toHaveProperty('admin_url')
})

test('platform feedback attempts discovered siblings before rejecting a manifest failure', async () => {
	consoleWarn.mockImplementation(() => {})
	const first = createSavedPackage({
		id: 'package-first',
		userId: 'admin-stable-1',
		sourceId: 'source-first',
	})
	const second = createSavedPackage({
		id: 'package-second',
		userId: 'admin-stable-1',
		sourceId: 'source-second',
	})
	const broken = createSavedPackage({
		id: 'package-broken',
		userId: 'admin-stable-2',
		sourceId: 'source-broken',
	})
	const unrelated = createSavedPackage({
		id: 'package-unrelated',
		userId: 'admin-stable-2',
		sourceId: 'source-unrelated',
	})
	mocks.listAdminAccountRows.mockResolvedValue([
		{ email: 'admin-1@example.com', stable_user_id: 'admin-stable-1' },
		{ email: 'admin-2@example.com', stable_user_id: 'admin-stable-2' },
	])
	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: D1Database, input: { userId: string }) =>
			input.userId === 'admin-stable-1' ? [first, second] : [broken, unrelated],
	)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === first.sourceId) return createManifest(first.id)
			if (input.sourceId === second.sourceId) return createManifest(second.id)
			if (input.sourceId === broken.sourceId) {
				throw new Error('manifest unavailable')
			}
			if (input.sourceId === unrelated.sourceId) {
				return createManifest(unrelated.id, false)
			}
			throw new Error(`Unexpected source id: ${input.sourceId}`)
		},
	)
	mocks.invokePackageSubscription.mockImplementation(
		async (input: { savedPackage: { id: string } }) => {
			if (input.savedPackage.id === first.id) {
				return {
					status: 500,
					body: {
						ok: false,
						error: {
							code: 'execution_failed',
							message: 'Handler failed.',
						},
					},
				}
			}
			return { status: 200, body: { ok: true } }
		},
	)

	await expect(
		dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: {
				APP_DB: {} as D1Database,
				BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
				APP_BASE_URL: 'https://heykody.dev',
			},
			feedback: openFeedback,
		}),
	).rejects.toThrow('Admin package subscription discovery failed.')

	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
	const invocationInputs = mocks.invokePackageSubscription.mock.calls.map(
		([input]) => input,
	)
	expect(invocationInputs).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				savedPackage: first,
				topic: platformFeedbackSubmittedTopic,
				params: buildPlatformFeedbackSubmittedEvent(openFeedback),
				idempotencyKey:
					'platform-feedback:feedback-1:package-first:platform.feedback.submitted',
				source: 'platform-feedback',
				actorTokenId: 'internal:platform-feedback-subscriptions',
			}),
			expect.objectContaining({
				savedPackage: second,
				topic: platformFeedbackSubmittedTopic,
				params: buildPlatformFeedbackSubmittedEvent(openFeedback),
				idempotencyKey:
					'platform-feedback:feedback-1:package-second:platform.feedback.submitted',
				source: 'platform-feedback',
				actorTokenId: 'internal:platform-feedback-subscriptions',
			}),
		]),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		{
			topic: platformFeedbackSubmittedTopic,
			packageId: broken.id,
			sourceId: broken.sourceId,
			error: expect.any(Error),
		},
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-handler-failed',
		{
			topic: platformFeedbackSubmittedTopic,
			packageId: first.id,
			status: 500,
		},
	)
	expect(consoleWarn).toHaveBeenCalledTimes(2)
})

test('generic admin fan-out defaults to skipping manifest and invocation failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const successful = createSavedPackage({
		id: 'package-successful',
		userId: 'admin-stable-1',
		sourceId: 'source-successful',
	})
	const broken = createSavedPackage({
		id: 'package-broken',
		userId: 'admin-stable-1',
		sourceId: 'source-broken',
	})
	const thrown = createSavedPackage({
		id: 'package-thrown',
		userId: 'admin-stable-1',
		sourceId: 'source-thrown',
	})
	mocks.listAdminAccountRows.mockResolvedValue([
		{ email: 'admin@example.com', stable_user_id: 'admin-stable-1' },
	])
	mocks.listSavedPackagesByUserId.mockResolvedValue([
		successful,
		thrown,
		broken,
	])
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === successful.sourceId) {
				return createManifest(successful.id)
			}
			if (input.sourceId === thrown.sourceId) {
				return createManifest(thrown.id)
			}
			throw new Error('manifest unavailable')
		},
	)
	mocks.invokePackageSubscription.mockImplementation(
		async (input: { savedPackage: { id: string } }) => {
			if (input.savedPackage.id === thrown.id) {
				throw new Error('invocation unavailable')
			}
			return { status: 200, body: { ok: true } }
		},
	)

	await expect(
		dispatchAdminPackageSubscriptionEvent({
			env: {
				APP_DB: {} as D1Database,
				BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
			},
			baseUrl: 'https://heykody.dev',
			topic: platformFeedbackSubmittedTopic,
			getParams: () => ({}),
			source: 'test',
			buildIdempotencyKey: (savedPackage) => `test:${savedPackage.id}`,
		}),
	).resolves.toEqual([{ status: 200, body: { ok: true } }, null])

	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-manifest-load-failed',
		expect.objectContaining({ packageId: broken.id }),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-invocation-failed',
		expect.objectContaining({ packageId: thrown.id }),
	)
})

test('platform feedback isolates terminal execution failures', async () => {
	consoleWarn.mockImplementation(() => {})
	const failed = createSavedPackage({
		id: 'package-execution-failed',
		userId: 'admin-stable-1',
		sourceId: 'source-execution-failed',
	})
	mocks.listAdminAccountRows.mockResolvedValue([
		{ email: 'admin@example.com', stable_user_id: 'admin-stable-1' },
	])
	mocks.listSavedPackagesByUserId.mockResolvedValue([failed])
	mocks.loadPackageManifestBySourceId.mockResolvedValue(
		createManifest(failed.id),
	)
	const executionFailure = {
		status: 500,
		body: {
			ok: false,
			error: {
				code: 'execution_failed',
				message: 'Handler failed.',
			},
		},
	}
	mocks.invokePackageSubscription.mockResolvedValue(executionFailure)

	await expect(
		dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: {
				APP_DB: {} as D1Database,
				BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
				APP_BASE_URL: 'https://heykody.dev',
			},
			feedback: openFeedback,
		}),
	).resolves.toEqual([executionFailure])
})

test.each([
	['idempotency_lookup_failed', 500],
	['idempotency_persistence_failed', 500],
	['idempotency_conflict_unresolved', 500],
	['invocation_in_progress', 409],
	['invocation_failed', 500],
	['idempotency_response_unavailable', 409],
] as const)(
	'platform feedback rejects retryable invocation infrastructure response %s after attempting siblings',
	async (code, status) => {
		consoleWarn.mockImplementation(() => {})
		const retryable = createSavedPackage({
			id: 'package-retryable',
			userId: 'admin-stable-1',
			sourceId: 'source-retryable',
		})
		const successfulSibling = createSavedPackage({
			id: 'package-successful',
			userId: 'admin-stable-1',
			sourceId: 'source-successful',
		})
		mocks.listAdminAccountRows.mockResolvedValue([
			{ email: 'admin@example.com', stable_user_id: 'admin-stable-1' },
		])
		mocks.listSavedPackagesByUserId.mockResolvedValue([
			retryable,
			successfulSibling,
		])
		mocks.loadPackageManifestBySourceId.mockImplementation(
			async (input: { sourceId: string }) => {
				if (input.sourceId === retryable.sourceId) {
					return createManifest(retryable.id)
				}
				if (input.sourceId === successfulSibling.sourceId) {
					return createManifest(successfulSibling.id)
				}
				throw new Error(`Unexpected source id: ${input.sourceId}`)
			},
		)
		mocks.invokePackageSubscription.mockImplementation(
			async (input: { savedPackage: { id: string } }) =>
				input.savedPackage.id === retryable.id
					? {
							status,
							body: {
								ok: false,
								error: {
									code,
									message: 'Please retry.',
								},
							},
						}
					: { status: 200, body: { ok: true } },
		)

		await expect(
			dispatchPlatformFeedbackSubmittedSubscriptionEvent({
				env: {
					APP_DB: {} as D1Database,
					BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
					APP_BASE_URL: 'https://heykody.dev',
				},
				feedback: openFeedback,
			}),
		).rejects.toThrow(
			'Admin package subscription dispatch encountered retryable package invocation infrastructure errors.',
		)

		expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
		expect(
			mocks.invokePackageSubscription.mock.calls.map(
				([{ savedPackage }]) => savedPackage.id,
			),
		).toEqual(expect.arrayContaining([retryable.id, successfulSibling.id]))
		expect(consoleWarn).toHaveBeenCalledWith(
			'admin-package-subscription-handler-failed',
			{
				topic: platformFeedbackSubmittedTopic,
				packageId: retryable.id,
				status,
			},
		)
	},
)
