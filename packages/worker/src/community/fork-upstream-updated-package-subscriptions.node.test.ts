import { beforeEach, expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { CommunityListingPublishedDispatchCancelledError } from './errors.ts'
import { communityForkUpstreamUpdatedTopic } from './fork-upstream-updated-subscription-event.ts'
import { type CommunityForkRecord } from './types.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	listCommunityForksByListingId: vi.fn(),
	getCommunityListingPublishedForAdmin: vi.fn(),
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
vi.mock('./repo.ts', () => ({
	listCommunityForksByListingId: mocks.listCommunityForksByListingId,
}))
vi.mock('./service.ts', () => ({
	getCommunityListingPublishedForAdmin:
		mocks.getCommunityListingPublishedForAdmin,
}))

const { dispatchCommunityForkUpstreamUpdatedSubscriptionEvents } =
	await import('./fork-upstream-updated-package-subscriptions.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		BUNDLE_ARTIFACTS_KV: {} as KVNamespace,
		APP_BASE_URL: 'https://heykody.dev',
	}
}

const listing = {
	id: 'listing-1',
	name: '@owner/discord-gateway',
	kodyId: 'discord-gateway',
	description: 'Discord helpers',
	publisherUsername: 'owner',
	publishedAt: '2026-09-30T12:00:00.000Z',
	publicUrl: 'https://heykody.dev/@owner/discord-gateway',
}

function forkRow(overrides: Partial<CommunityForkRecord>): CommunityForkRecord {
	return {
		id: 'fork-1',
		listingId: 'listing-1',
		forkerUserId: 'stable-forker-a',
		originCommit: 'commit-1',
		forkedPackageId: 'forked-package-1',
		forkedSourceId: 'forked-source-1',
		targetKodyId: 'discord-gateway',
		createdAt: '2026-09-01T00:00:00.000Z',
		adoptedAt: null,
		adoptionNote: null,
		...overrides,
	}
}

function savedPackage(userId: string, id: string) {
	return { id, userId, sourceId: `source-${id}`, kodyId: id, name: `@u/${id}` }
}

function manifest(topics: Array<string>) {
	return {
		manifest: {
			kody: {
				subscriptions: Object.fromEntries(
					topics.map((topic) => [topic, { handler: './src/on-event.ts' }]),
				),
			},
		},
	}
}

const message = {
	eventId: 'event-1',
	listingId: 'listing-1',
	previous: { pinnedCommit: 'commit-1', packageVersion: '1.0.0' },
	current: { pinnedCommit: 'commit-2', packageVersion: '1.1.0' },
	publishedAt: '2026-09-30T12:00:00.000Z',
}

function invokedPackageIds() {
	return mocks.invokePackageSubscription.mock.calls.map(
		([call]) => (call as { savedPackage: { id: string } }).savedPackage.id,
	)
}

beforeEach(() => {
	mocks.invokePackageSubscription.mockResolvedValue({ status: 200, body: {} })
	mocks.getCommunityListingPublishedForAdmin.mockResolvedValue(listing)
	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: unknown, input: { userId: string }) => {
			switch (input.userId) {
				case 'stable-forker-a':
					return [
						savedPackage('stable-forker-a', 'auto-rebase'),
						savedPackage('stable-forker-a', 'unrelated'),
					]
				case 'stable-forker-b':
					return [savedPackage('stable-forker-b', 'plain-notifier')]
				case 'stable-forker-c':
					return [savedPackage('stable-forker-c', 'discord-ping')]
				default:
					return []
			}
		},
	)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) =>
			input.sourceId === 'source-unrelated'
				? manifest(['repo.pushed'])
				: manifest([communityForkUpstreamUpdatedTopic]),
	)
})

test('delivers one event per fork to subscribed packages of every forker behind the new pinned commit', async () => {
	mocks.listCommunityForksByListingId.mockResolvedValue([
		forkRow({ id: 'fork-1' }),
		forkRow({
			id: 'fork-2',
			forkedPackageId: 'forked-package-2',
			targetKodyId: 'discord-gateway-2',
		}),
		forkRow({ id: 'fork-b', forkerUserId: 'stable-forker-b' }),
		forkRow({
			id: 'fork-c',
			forkerUserId: 'stable-forker-c',
			originCommit: 'commit-0',
		}),
		forkRow({ id: 'fork-no-packages', forkerUserId: 'stable-missing' }),
		forkRow({ id: 'fork-current', originCommit: 'commit-2' }),
	])

	await dispatchCommunityForkUpstreamUpdatedSubscriptionEvents({
		env: createEnv(),
		message,
	})

	const calls = mocks.invokePackageSubscription.mock.calls.map(
		([call]) =>
			call as {
				savedPackage: { id: string }
				topic: string
				params: Record<string, unknown>
				idempotencyKey: string
				source: string
			},
	)
	expect(
		calls.map((call) => [call.savedPackage.id, call.idempotencyKey]),
	).toEqual([
		[
			'auto-rebase',
			'community-fork-upstream-updated:event-1:fork-1:auto-rebase',
		],
		[
			'auto-rebase',
			'community-fork-upstream-updated:event-1:fork-2:auto-rebase',
		],
		[
			'plain-notifier',
			'community-fork-upstream-updated:event-1:fork-b:plain-notifier',
		],
		[
			'discord-ping',
			'community-fork-upstream-updated:event-1:fork-c:discord-ping',
		],
	])
	for (const call of calls) {
		expect(call.topic).toBe('community.fork.upstream_updated')
		expect(call.source).toBe('community-fork-upstream-updated')
	}
	expect(calls[0]?.params).toEqual({
		event: 'community.fork.upstream_updated',
		event_id: 'event-1',
		listing: {
			id: 'listing-1',
			name: '@owner/discord-gateway',
			kody_id: 'discord-gateway',
			public_url: 'https://heykody.dev/@owner/discord-gateway',
		},
		publisher: { username: 'owner' },
		fork: {
			id: 'fork-1',
			package_id: 'forked-package-1',
			kody_id: 'discord-gateway',
			origin_commit: 'commit-1',
			forked_at: '2026-09-01T00:00:00.000Z',
		},
		previous: { pinned_commit: 'commit-1', package_version: '1.0.0' },
		current: { pinned_commit: 'commit-2', package_version: '1.1.0' },
		published_at: '2026-09-30T12:00:00.000Z',
	})
	const discoveredUsers = mocks.listSavedPackagesByUserId.mock.calls.map(
		([, input]) => (input as { userId: string }).userId,
	)
	expect(discoveredUsers).toEqual([
		'stable-forker-a',
		'stable-forker-b',
		'stable-forker-c',
		'stable-missing',
	])
})

test('does nothing when the listing has no forks behind the new pinned commit', async () => {
	mocks.listCommunityForksByListingId.mockResolvedValue([])
	await expect(
		dispatchCommunityForkUpstreamUpdatedSubscriptionEvents({
			env: createEnv(),
			message,
		}),
	).resolves.toEqual([])

	mocks.listCommunityForksByListingId.mockResolvedValue([
		forkRow({ originCommit: 'commit-2' }),
	])
	await expect(
		dispatchCommunityForkUpstreamUpdatedSubscriptionEvents({
			env: createEnv(),
			message,
		}),
	).resolves.toEqual([])

	expect(mocks.getCommunityListingPublishedForAdmin).not.toHaveBeenCalled()
	expect(mocks.listSavedPackagesByUserId).not.toHaveBeenCalled()
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
})

test('skips a forker whose saved-package lookup fails, delivers to siblings, and rejects for Queue retry', async () => {
	mocks.listSavedPackagesByUserId.mockImplementation(
		async (_db: unknown, input: { userId: string }) => {
			if (input.userId === 'stable-forker-a') {
				throw new Error('D1 unavailable')
			}
			return [savedPackage(input.userId, 'discord-ping')]
		},
	)
	mocks.listCommunityForksByListingId.mockResolvedValue([
		forkRow({ id: 'fork-a', forkerUserId: 'stable-forker-a' }),
		forkRow({ id: 'fork-c', forkerUserId: 'stable-forker-c' }),
	])

	await expect(
		dispatchCommunityForkUpstreamUpdatedSubscriptionEvents({
			env: createEnv(),
			message,
		}),
	).rejects.toThrow('subscription discovery failed')
	expect(invokedPackageIds()).toEqual(['discord-ping'])
})

test('cancels when the listing is no longer active', async () => {
	mocks.listCommunityForksByListingId.mockResolvedValue([forkRow({})])
	mocks.getCommunityListingPublishedForAdmin.mockResolvedValue(null)

	await expect(
		dispatchCommunityForkUpstreamUpdatedSubscriptionEvents({
			env: createEnv(),
			message,
		}),
	).rejects.toBeInstanceOf(CommunityListingPublishedDispatchCancelledError)
	expect(mocks.listSavedPackagesByUserId).not.toHaveBeenCalled()
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
})

test('rejects for Queue retry after siblings finish when invocation infrastructure fails', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.listCommunityForksByListingId.mockResolvedValue([
		forkRow({ id: 'fork-1' }),
		forkRow({ id: 'fork-c', forkerUserId: 'stable-forker-c' }),
	])
	mocks.invokePackageSubscription.mockImplementation(
		async (input: { savedPackage: { id: string } }) =>
			input.savedPackage.id === 'auto-rebase'
				? {
						status: 503,
						body: { error: { code: 'idempotency_lookup_failed' } },
					}
				: { status: 200, body: {} },
	)

	await expect(
		dispatchCommunityForkUpstreamUpdatedSubscriptionEvents({
			env: createEnv(),
			message,
		}),
	).rejects.toThrow(/retryable package invocation infrastructure errors/)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'community-fork-upstream-updated-invocation-failed',
		expect.objectContaining({ forkId: 'fork-1', packageId: 'auto-rebase' }),
	)
})

test('rejects for Queue retry when subscriber manifest discovery fails', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.listCommunityForksByListingId.mockResolvedValue([forkRow({})])
	mocks.loadPackageManifestBySourceId.mockRejectedValue(
		new Error('KV unavailable'),
	)

	await expect(
		dispatchCommunityForkUpstreamUpdatedSubscriptionEvents({
			env: createEnv(),
			message,
		}),
	).rejects.toThrow(/discovery failed/)
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
})
