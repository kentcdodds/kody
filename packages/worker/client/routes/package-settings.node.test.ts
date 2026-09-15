import { type Handle } from 'remix/ui'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import {
	clearPreloadedNavigationData,
	setPreloadedNavigationData,
} from '#client/navigation-data.ts'
import { createRouteData } from '#client/route-data.tsx'
import {
	consumePackageSettingsShell,
	toPackageSettingsShell,
} from './community-detail-shared.ts'

const previousDocument = globalThis.document
beforeEach(() => {
	clearPreloadedNavigationData()
	globalThis.document = {} as unknown as Document
})
afterEach(() => {
	clearPreloadedNavigationData()
	globalThis.document = previousDocument
})

type QueuedTask = (signal: AbortSignal) => unknown

function createStubHandle() {
	const queuedTasks: Array<QueuedTask> = []
	const handle = {
		context: {
			get(provider: unknown) {
				if (provider === AppLoaderDataProvider) {
					return { loaderData: undefined, consumedKeys: new Set() }
				}
				throw new Error('context not available')
			},
		},
		queueTask(task: QueuedTask) {
			queuedTasks.push(task)
		},
		update() {
			return Promise.resolve(new AbortController().signal)
		},
	} as unknown as Handle
	return {
		handle,
		queuedTasks,
		async flushTasks(signal = new AbortController().signal) {
			const tasks = queuedTasks.splice(0)
			for (const task of tasks) await task(signal)
		},
	}
}

test('a missing package maps to a not-found settings shell', () => {
	expect(toPackageSettingsShell({ ok: false, notFound: true })).toEqual({
		kind: 'not-found',
	})
	expect(toPackageSettingsShell({ ok: false, unauthorized: true })).toEqual({
		kind: 'unauthorized',
	})
})

test('owner settings shell keeps listing id and default branch for the Files tab', () => {
	expect(
		toPackageSettingsShell({
			ok: true,
			listingId: 'listing-1',
			defaultBranch: 'develop',
			name: '@kentcdodds/packages',
			description: 'Reserved kody id',
			ownerProfilePublic: false,
			forkPrompt: '',
			loggedIn: true,
			viewerIsAdmin: false,
			trusted: false,
			featured: false,
			readmeContent: null,
			hasAgentsDocs: false,
			imageBaseHref: null,
			viewerInstall: null,
			ownerPackage: {
				id: 'pkg-1',
				name: '@kentcdodds/packages',
				kodyId: 'packages',
				description: 'Reserved kody id',
				tags: [],
				hasApp: false,
				sourceId: 'src-1',
				lockedAt: null,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
				hidden: false,
				isPrivate: true,
				hasCommunityListing: true,
				listingAhead: null,
				forkAhead: null,
				searchText: null,
				exports: null,
				tokens: [],
				publishedCommit: null,
			},
			username: 'kentcdodds',
			kodyId: 'packages',
			viewerIsOwner: true,
			isPrivate: true,
			invocationUrlOrigin: 'https://example.com',
		}),
	).toEqual({
		kind: 'owner',
		username: 'kentcdodds',
		kodyId: 'packages',
		isPrivate: true,
		listingId: 'listing-1',
		defaultBranch: 'develop',
		ownerProfilePublic: false,
		ownerPackage: expect.objectContaining({ kodyId: 'packages' }),
	})
})

test('preloaded settings 404 is ready immediately and does not fallback-fetch', async () => {
	const { handle, queuedTasks, flushTasks } = createStubHandle()
	const loads: Array<string> = []
	const settingsData = createRouteData({
		consume: consumePackageSettingsShell,
		async load(href) {
			loads.push(href)
			return { kind: 'not-found' as const }
		},
	})

	setPreloadedNavigationData('/@bad/bad-404/settings', {
		communityDetailShell: { ok: false, notFound: true },
	})
	expect(settingsData.read(handle, '/@bad/bad-404/settings')).toEqual({
		kind: 'ready',
		data: { kind: 'not-found' },
		stale: false,
		error: null,
	})
	await flushTasks()
	expect(settingsData.read(handle, '/@bad/bad-404/settings').kind).toBe('ready')
	expect(queuedTasks).toHaveLength(0)
	expect(loads).toEqual([])
})
