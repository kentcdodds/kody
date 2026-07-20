import { expect, test, vi } from 'vitest'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { platformFeedbackContentWarning } from './content-warning.ts'
import { PlatformFeedbackDispatchCancelledError } from './errors.ts'
import {
	buildPlatformFeedbackSubmittedEvent,
	platformFeedbackSubmittedTopic,
} from './subscription-event.ts'
import { type PlatformFeedbackRecord } from './types.ts'

const mocks = vi.hoisted(() => ({
	getPlatformFeedbackForAdmin: vi.fn(),
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

vi.mock('./service.ts', () => ({
	getPlatformFeedbackForAdmin: mocks.getPlatformFeedbackForAdmin,
}))

const { dispatchPlatformFeedbackSubmittedSubscriptionEvent } =
	await import('./package-subscriptions.ts')

const openFeedback = {
	id: 'feedback-1',
	submitterUserId: 'submitter-1',
	submitterUsername: 'feedback-author',
	submitterEmail: 'feedback-author@example.com',
	category: 'friction' as const,
	summary: 'The setup path is confusing',
	details: 'The setup flow does not explain which action comes next.',
	status: 'open' as const,
	reviewedByUserId: null,
	reviewedAt: null,
	adminNote: null,
	createdAt: '2026-07-19T00:00:00.000Z',
	updatedAt: '2026-07-19T00:00:00.000Z',
} satisfies PlatformFeedbackRecord

function buildExpectedEvent(feedback: PlatformFeedbackRecord = openFeedback) {
	return buildPlatformFeedbackSubmittedEvent({
		baseUrl: 'https://heykody.dev',
		feedback,
	})
}

function mockResolvedFeedback(feedback: PlatformFeedbackRecord = openFeedback) {
	mocks.getPlatformFeedbackForAdmin.mockResolvedValue(feedback)
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
		isPrivate: false,
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

function createDispatchEnv() {
	return {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
		APP_BASE_URL: 'https://heykody.dev',
	}
}

test('platform feedback submitted payload contains exactly the approved event fields and encoded admin URL', () => {
	const feedback = {
		...openFeedback,
		id: 'feedback /?#1',
	}
	const payload = buildPlatformFeedbackSubmittedEvent({
		baseUrl: 'https://kody.example.com',
		feedback,
	})

	expect(payload).toEqual({
		event: 'platform.feedback.submitted',
		content_warning: platformFeedbackContentWarning,
		admin_url:
			'https://kody.example.com/admin/platform-feedback?feedbackId=feedback%20%2F%3F%231',
		feedback: {
			id: 'feedback /?#1',
			category: 'friction',
			status: 'open',
			created_at: '2026-07-19T00:00:00.000Z',
			summary_untrusted: 'The setup path is confusing',
			details_untrusted:
				'The setup flow does not explain which action comes next.',
		},
		submitter: {
			user_id: 'submitter-1',
			username: 'feedback-author',
			email: 'feedback-author@example.com',
		},
	})
	expect(Object.keys(payload.feedback).sort()).toEqual(
		[
			'category',
			'created_at',
			'details_untrusted',
			'id',
			'status',
			'summary_untrusted',
		].sort(),
	)
	expect(payload.feedback).not.toHaveProperty('summary')
	expect(payload.feedback).not.toHaveProperty('details')
	for (const deniedField of [
		'admin_note',
		'reviewed_by_user_id',
		'reviewed_at',
		'revision',
		'updated_at',
		'roles',
		'plan',
		'packages',
	]) {
		expect(payload).not.toHaveProperty(deniedField)
		expect(payload.feedback).not.toHaveProperty(deniedField)
		expect(payload.submitter).not.toHaveProperty(deniedField)
	}

	const legacyPayload = buildPlatformFeedbackSubmittedEvent({
		baseUrl: 'https://kody.example.com',
		feedback: {
			...feedback,
			submitterUsername: null,
			submitterEmail: null,
		},
	})
	expect(legacyPayload.submitter).toEqual({
		user_id: 'submitter-1',
		username: null,
		email: null,
	})
})

test('platform feedback dispatch isolates terminal handler failures and rejects after retryable or discovery failures', async () => {
	consoleWarn.mockImplementation(() => {})
	mockResolvedFeedback()

	const terminalOnly = createSavedPackage({
		id: 'package-terminal',
		userId: 'admin-stable-1',
		sourceId: 'source-terminal',
	})
	mocks.listAdminAccountRows.mockResolvedValue([
		{ email: 'admin@example.com', stable_user_id: 'admin-stable-1' },
	])
	mocks.listSavedPackagesByUserId.mockResolvedValue([terminalOnly])
	mocks.loadPackageManifestBySourceId.mockResolvedValue(
		createManifest(terminalOnly.id),
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
			env: createDispatchEnv(),
			feedbackId: openFeedback.id,
		}),
	).resolves.toEqual([executionFailure])
	expect(consoleWarn).toHaveBeenCalledWith(
		'admin-package-subscription-handler-failed',
		{
			topic: platformFeedbackSubmittedTopic,
			packageId: terminalOnly.id,
			status: 500,
		},
	)

	consoleWarn.mockClear()
	mocks.invokePackageSubscription.mockClear()
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
				return executionFailure
			}
			return { status: 200, body: { ok: true } }
		},
	)

	await expect(
		dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: createDispatchEnv(),
			feedbackId: openFeedback.id,
		}),
	).rejects.toThrow('Admin package subscription discovery failed.')
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
	expect(
		mocks.invokePackageSubscription.mock.calls.map(([input]) => input),
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				savedPackage: first,
				topic: platformFeedbackSubmittedTopic,
				params: buildExpectedEvent(),
				idempotencyKey:
					'platform-feedback:feedback-1:package-first:platform.feedback.submitted',
				source: 'platform-feedback',
				actorTokenId: 'internal:platform-feedback-subscriptions',
			}),
			expect.objectContaining({
				savedPackage: second,
				topic: platformFeedbackSubmittedTopic,
				params: buildExpectedEvent(),
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
	expect(consoleWarn).toHaveBeenCalledTimes(2)

	consoleWarn.mockClear()
	mocks.invokePackageSubscription.mockClear()
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
						status: 409,
						body: {
							ok: false,
							error: {
								code: 'invocation_in_progress',
								message: 'Please retry.',
							},
						},
					}
				: { status: 200, body: { ok: true } },
	)

	await expect(
		dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: createDispatchEnv(),
			feedbackId: openFeedback.id,
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
			status: 409,
		},
	)
})

test('platform feedback skips lazy enrichment without admins and cancels permanently when the row is deleted', async () => {
	mocks.getPlatformFeedbackForAdmin.mockClear()
	mocks.invokePackageSubscription.mockClear()
	mocks.listAdminAccountRows.mockResolvedValue([])

	await expect(
		dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: createDispatchEnv(),
			feedbackId: openFeedback.id,
		}),
	).resolves.toEqual([])
	expect(mocks.getPlatformFeedbackForAdmin).not.toHaveBeenCalled()

	const subscribed = createSavedPackage({
		id: 'package-subscriber',
		userId: 'admin-stable-1',
		sourceId: 'source-subscriber',
	})
	mocks.listAdminAccountRows.mockResolvedValue([
		{ email: 'admin@example.com', stable_user_id: 'admin-stable-1' },
	])
	mocks.listSavedPackagesByUserId.mockResolvedValue([subscribed])
	mocks.loadPackageManifestBySourceId.mockResolvedValue(
		createManifest(subscribed.id),
	)
	mocks.getPlatformFeedbackForAdmin.mockResolvedValue(null)

	await expect(
		dispatchPlatformFeedbackSubmittedSubscriptionEvent({
			env: createDispatchEnv(),
			feedbackId: 'deleted-feedback',
		}),
	).rejects.toBeInstanceOf(PlatformFeedbackDispatchCancelledError)
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
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
