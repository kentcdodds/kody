import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
	listSavedPackagesByIds: mocks.listSavedPackagesByIds,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

const {
	buildPackageSubscriptionTopicMapKey,
	getOrFillPackageSubscriptionTopicMap,
	invalidatePackageSubscriptionTopicMap,
	refreshPackageSubscriptionTopicMap,
} = await import('./subscription-topic-cache.ts')
const { loadMatchingPackageSubscriptions } =
	await import('./admin-package-subscriptions.ts')

function createKv() {
	const store = new Map<string, string>()
	const kv = {
		get: vi.fn(async (key: string, typeOrOpts?: 'json' | { type?: string }) => {
			const value = store.get(key) ?? null
			const asJson =
				typeOrOpts === 'json' ||
				(typeof typeOrOpts === 'object' && typeOrOpts?.type === 'json')
			return asJson && value ? JSON.parse(value) : value
		}),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key)
		}),
	} as unknown as KVNamespace
	return { store, kv }
}

function savedPackage(input: {
	id: string
	kodyId: string
	topics?: Array<string>
}) {
	return {
		id: input.id,
		userId: 'user-1',
		name: `@user/${input.kodyId}`,
		kodyId: input.kodyId,
		description: input.kodyId,
		tags: [],
		searchText: null,
		sourceId: `source-${input.id}`,
		hasApp: false,
		hidden: false,
		isPrivate: true,
		lockedAt: null,
		createdAt: '2026-10-02T00:00:00.000Z',
		updatedAt: '2026-10-02T00:00:00.000Z',
		topics: input.topics ?? [],
	}
}

function manifestFor(topics: Array<string>) {
	return {
		manifest: {
			name: '@user/pkg',
			kody: {
				id: 'pkg',
				description: 'pkg',
				subscriptions: Object.fromEntries(
					topics.map((topic) => [
						topic,
						{ handler: './src/handler.ts', description: null },
					]),
				),
			},
		},
	}
}

test('wake miss fills KV then a second wake does not reload every manifest', async () => {
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	const packages = [
		savedPackage({
			id: 'pkg-a',
			kodyId: 'a',
			topics: ['email.message.received'],
		}),
		savedPackage({ id: 'pkg-b', kodyId: 'b', topics: [] }),
		savedPackage({
			id: 'pkg-c',
			kodyId: 'c',
			topics: ['email.message.received'],
		}),
	]
	mocks.listSavedPackagesByUserId.mockResolvedValue(packages)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const match = packages.find((entry) => entry.sourceId === input.sourceId)
			return manifestFor(match?.topics ?? [])
		},
	)
	mocks.listSavedPackagesByIds.mockImplementation(
		async (_db: unknown, input: { packageIds: Array<string> }) =>
			packages.filter((entry) => input.packageIds.includes(entry.id)),
	)

	const first = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		topic: 'email.message.received',
	})
	expect(
		first.subscriptions.map((entry) => entry.savedPackage.id).sort(),
	).toEqual(['pkg-a', 'pkg-c'])
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(3)
	expect(store.has(buildPackageSubscriptionTopicMapKey('user-1'))).toBe(true)

	mocks.loadPackageManifestBySourceId.mockClear()
	mocks.listSavedPackagesByUserId.mockClear()

	const second = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		topic: 'email.message.received',
	})
	expect(
		second.subscriptions.map((entry) => entry.savedPackage.id).sort(),
	).toEqual(['pkg-a', 'pkg-c'])
	// Cache hit: only candidate subscriber manifests, not every saved package.
	expect(mocks.listSavedPackagesByUserId).not.toHaveBeenCalled()
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(2)
	expect(
		mocks.loadPackageManifestBySourceId.mock.calls
			.map(([arg]) => (arg as { sourceId: string }).sourceId)
			.sort(),
	).toEqual(['source-pkg-a', 'source-pkg-c'])
})

test('KV miss still finds the right subscribers', async () => {
	const { kv } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	const packages = [
		savedPackage({ id: 'pkg-noise', kodyId: 'noise', topics: [] }),
		savedPackage({
			id: 'pkg-hit',
			kodyId: 'hit',
			topics: ['repo.pushed'],
		}),
	]
	mocks.listSavedPackagesByUserId.mockResolvedValue(packages)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const match = packages.find((entry) => entry.sourceId === input.sourceId)
			return manifestFor(match?.topics ?? [])
		},
	)
	mocks.listSavedPackagesByIds.mockImplementation(
		async (_db: unknown, input: { packageIds: Array<string> }) =>
			packages.filter((entry) => input.packageIds.includes(entry.id)),
	)

	const result = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		topic: 'repo.pushed',
	})
	expect(result.subscriptions).toHaveLength(1)
	expect(result.subscriptions[0]?.savedPackage.id).toBe('pkg-hit')
})

test('publish refresh changes who matches without waiting for a TTL', async () => {
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	const before = [
		savedPackage({
			id: 'pkg-old',
			kodyId: 'old',
			topics: ['integration.auth.failed'],
		}),
		savedPackage({ id: 'pkg-new', kodyId: 'new', topics: [] }),
	]
	mocks.listSavedPackagesByUserId.mockResolvedValue(before)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const match = before.find((entry) => entry.sourceId === input.sourceId)
			return manifestFor(match?.topics ?? [])
		},
	)
	mocks.listSavedPackagesByIds.mockImplementation(
		async (_db: unknown, input: { packageIds: Array<string> }) =>
			before.filter((entry) => input.packageIds.includes(entry.id)),
	)

	await getOrFillPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
	})
	const key = buildPackageSubscriptionTopicMapKey('user-1')
	expect(store.has(key)).toBe(true)

	// Simulate publish: pkg-new gains the topic; pkg-old drops it.
	const after = [
		savedPackage({ id: 'pkg-old', kodyId: 'old', topics: [] }),
		savedPackage({
			id: 'pkg-new',
			kodyId: 'new',
			topics: ['integration.auth.failed'],
		}),
	]
	mocks.listSavedPackagesByUserId.mockResolvedValue(after)
	mocks.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			const match = after.find((entry) => entry.sourceId === input.sourceId)
			return manifestFor(match?.topics ?? [])
		},
	)
	mocks.listSavedPackagesByIds.mockImplementation(
		async (_db: unknown, input: { packageIds: Array<string> }) =>
			after.filter((entry) => input.packageIds.includes(entry.id)),
	)

	await refreshPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
	})

	mocks.loadPackageManifestBySourceId.mockClear()
	const matched = await loadMatchingPackageSubscriptions({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		topic: 'integration.auth.failed',
	})
	expect(matched.subscriptions.map((entry) => entry.savedPackage.id)).toEqual([
		'pkg-new',
	])
	// Refreshed map is live immediately — only the new subscriber is loaded.
	expect(mocks.loadPackageManifestBySourceId).toHaveBeenCalledTimes(1)
	expect(mocks.loadPackageManifestBySourceId.mock.calls[0]?.[0]).toEqual(
		expect.objectContaining({ sourceId: 'source-pkg-new' }),
	)
})

test('invalidate drops the map so the next wake cannot use a stale projection', async () => {
	const { kv, store } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	mocks.listSavedPackagesByUserId.mockResolvedValue([])
	await getOrFillPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
	})
	const key = buildPackageSubscriptionTopicMapKey('user-1')
	expect(store.has(key)).toBe(true)
	await invalidatePackageSubscriptionTopicMap({ env, userId: 'user-1' })
	expect(store.has(key)).toBe(false)
})

test('written map has no expiration TTL that could hide a new subscription', async () => {
	const { kv } = createKv()
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: kv,
	} as Env
	mocks.listSavedPackagesByUserId.mockResolvedValue([])
	await getOrFillPackageSubscriptionTopicMap({
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
	})
	expect(kv.put).toHaveBeenCalledWith(
		buildPackageSubscriptionTopicMapKey('user-1'),
		expect.any(String),
	)
	const putOptions = (kv.put as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]
	expect(putOptions).toBeUndefined()
})
