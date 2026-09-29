import { type Handle } from 'remix/ui'
import { expect, test } from 'vitest'
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

type QueuedTask = (signal: AbortSignal) => unknown

/** Browser-like navigation state; dispose restores `document` and the cache. */
function createStubHandle() {
	const previousDocument = globalThis.document
	clearPreloadedNavigationData()
	globalThis.document = {} as unknown as Document
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
		[Symbol.dispose]() {
			clearPreloadedNavigationData()
			globalThis.document = previousDocument
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

test('preloaded settings 404 is ready immediately and does not fallback-fetch', async () => {
	using stub = createStubHandle()
	const { handle, queuedTasks, flushTasks } = stub
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
