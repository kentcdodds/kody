import { type Handle } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type DocDetailLoaderData } from '#universal/loader-data.ts'
import { AppLoaderDataProvider } from './loader-data-context.tsx'
import {
	clearPreloadedNavigationData,
	markNavigationDataStale,
	setPreloadedNavigationData,
} from './navigation-data.ts'
import { createRouteData, renderRoutePendingStatus } from './route-data.tsx'

// The fallback fetch only queues in a browser; stand in for `document` so
// the helper takes the client path.
const previousDocument = globalThis.document
beforeEach(() => {
	clearPreloadedNavigationData()
	globalThis.document = {} as unknown as Document
})
afterEach(() => {
	clearPreloadedNavigationData()
	globalThis.document = previousDocument
})

function createDoc(slug: string): DocDetailLoaderData {
	return {
		ok: true,
		id: slug,
		slug,
		title: slug,
		summary: '',
		body: `# ${slug}`,
		category: 'guide',
		audience: 'humans',
	} as DocDetailLoaderData
}

type QueuedTask = (signal: AbortSignal) => unknown

function createStubHandle() {
	const queuedTasks: Array<QueuedTask> = []
	let updateCount = 0
	const handle = {
		context: {
			get(provider: unknown) {
				if (provider === AppLoaderDataProvider) {
					return { loaderData: undefined, consumedKeys: new Set() }
				}
				// No RouterLocationProvider in the stub tree; consumption
				// falls through to the preloaded navigation slot.
				throw new Error('context not available')
			},
		},
		queueTask(task: QueuedTask) {
			queuedTasks.push(task)
		},
		update() {
			updateCount++
			return Promise.resolve(new AbortController().signal)
		},
	} as unknown as Handle
	return {
		handle,
		queuedTasks,
		/** Run queued tasks like the scheduler would, with a live signal. */
		async flushTasks(signal = new AbortController().signal) {
			const tasks = queuedTasks.splice(0)
			for (const task of tasks) await task(signal)
		},
		getUpdateCount: () => updateCount,
	}
}

function createDeferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

test('preloaded navigation data replaces the previous payload in one render and is never refetched', async () => {
	const { handle, queuedTasks, flushTasks } = createStubHandle()
	const loads: Array<string> = []
	const docData = createRouteData({
		key: 'docDetail',
		async load(href) {
			loads.push(href)
			return createDoc('fallback')
		},
	})

	setPreloadedNavigationData('/docs/memory', { docDetail: createDoc('memory') })
	let snapshot = docData.read(handle, '/docs/memory')
	expect(snapshot).toEqual({
		kind: 'ready',
		data: createDoc('memory'),
		stale: false,
		error: null,
	})
	// The consume helper schedules one corrective render; run it. That render
	// finds nothing to consume and must not queue a fetch.
	await flushTasks()
	snapshot = docData.read(handle, '/docs/memory')
	expect(snapshot.kind).toBe('ready')
	expect(queuedTasks).toHaveLength(0)

	// SPA navigation to another guide with the router's preloaded payload.
	setPreloadedNavigationData('/docs/secrets', {
		docDetail: createDoc('secrets'),
	})
	snapshot = docData.read(handle, '/docs/secrets')
	expect(snapshot).toEqual({
		kind: 'ready',
		data: createDoc('secrets'),
		stale: false,
		error: null,
	})
	await flushTasks()
	snapshot = docData.read(handle, '/docs/secrets')
	expect(snapshot.kind).toBe('ready')
	expect(snapshot.data?.slug).toBe('secrets')
	expect(loads).toEqual([])
})

test('a commit without preloaded data keeps the previous payload on screen (stale + pending) until the fallback fetch lands', async () => {
	const { handle, queuedTasks, flushTasks, getUpdateCount } = createStubHandle()
	const deferred = createDeferred<DocDetailLoaderData | null>()
	const docData = createRouteData({
		key: 'docDetail',
		load: () => deferred.promise,
	})

	setPreloadedNavigationData('/docs/memory', { docDetail: createDoc('memory') })
	docData.read(handle, '/docs/memory')
	await flushTasks()

	// The router's loader failed for /docs/secrets, so the route commits with
	// nothing preloaded. It must keep showing "memory" while it refetches.
	const pending = docData.read(handle, '/docs/secrets')
	expect(pending.kind).toBe('pending')
	expect(pending.stale).toBe(true)
	expect(pending.data?.slug).toBe('memory')
	expect(queuedTasks).toHaveLength(1)

	// Re-renders while the fetch is in flight do not queue a second fetch.
	expect(docData.read(handle, '/docs/secrets').kind).toBe('pending')
	expect(queuedTasks).toHaveLength(1)

	const updatesBeforeFetch = getUpdateCount()
	const flushing = flushTasks()
	deferred.resolve(createDoc('secrets'))
	await flushing
	// Exactly one render for the applied result.
	expect(getUpdateCount()).toBe(updatesBeforeFetch + 1)
	const ready = docData.read(handle, '/docs/secrets')
	expect(ready).toEqual({
		kind: 'ready',
		data: createDoc('secrets'),
		stale: false,
		error: null,
	})
})

test('fallback fetch outcomes: not-found, error (latched), and stale refresh', async () => {
	const { handle, queuedTasks, flushTasks } = createStubHandle()
	let nextResult: () => Promise<DocDetailLoaderData | null> = () =>
		Promise.resolve(null)
	const docData = createRouteData({
		key: 'docDetail',
		load: () => nextResult(),
	})

	// Cold SPA mount: nothing to keep, pending with no data.
	expect(docData.read(handle, '/docs/missing')).toEqual({
		kind: 'pending',
		data: null,
		stale: false,
		error: null,
	})
	await flushTasks()
	expect(docData.read(handle, '/docs/missing')).toEqual({
		kind: 'not-found',
		data: null,
		stale: false,
		error: null,
	})
	expect(queuedTasks).toHaveLength(0)

	// A failing fetch reports `error` once and does not re-queue in a loop.
	nextResult = () => Promise.reject(new Error('boom'))
	expect(docData.read(handle, '/docs/broken').kind).toBe('pending')
	await flushTasks()
	expect(docData.read(handle, '/docs/broken')).toEqual({
		kind: 'error',
		data: null,
		stale: false,
		error: new Error('boom'),
	})
	expect(docData.read(handle, '/docs/broken').kind).toBe('error')
	expect(queuedTasks).toHaveLength(0)

	// Same-location stale refresh (form POST redirect back here) refetches
	// while keeping the current payload visible.
	nextResult = () => Promise.resolve(createDoc('memory'))
	setPreloadedNavigationData('/docs/memory', { docDetail: createDoc('memory') })
	docData.read(handle, '/docs/memory')
	await flushTasks()
	markNavigationDataStale('/docs/memory')
	const refreshing = docData.read(handle, '/docs/memory')
	expect(refreshing.kind).toBe('pending')
	expect(refreshing.stale).toBe(false)
	expect(refreshing.data?.slug).toBe('memory')
	expect(queuedTasks).toHaveLength(1)
	await flushTasks()
	expect(docData.read(handle, '/docs/memory').kind).toBe('ready')
})

test('an aborted fallback fetch releases the latch and schedules the render that re-queues it', async () => {
	const { handle, queuedTasks, flushTasks, getUpdateCount } = createStubHandle()
	const docData = createRouteData({
		key: 'docDetail',
		load: (_href, signal) =>
			new Promise<DocDetailLoaderData | null>((_resolve, reject) => {
				signal.addEventListener('abort', () => reject(new Error('aborted')))
			}),
	})

	expect(docData.read(handle, '/docs/memory').kind).toBe('pending')
	expect(queuedTasks).toHaveLength(1)
	// remix/ui aborts the task signal when the component re-renders for an
	// unrelated reason (e.g. the shell refreshing its session).
	const controller = new AbortController()
	const flushing = flushTasks(controller.signal)
	controller.abort()
	await flushing
	expect(getUpdateCount()).toBe(1)

	// The scheduled render re-queues the fetch instead of sitting in pending.
	expect(docData.read(handle, '/docs/memory').kind).toBe('pending')
	expect(queuedTasks).toHaveLength(1)
})

test('late completions for a location the user already left are dropped', async () => {
	const { handle, flushTasks, getUpdateCount } = createStubHandle()
	const deferred = createDeferred<DocDetailLoaderData | null>()
	const docData = createRouteData({
		key: 'docDetail',
		load: () => deferred.promise,
	})

	expect(docData.read(handle, '/docs/memory').kind).toBe('pending')
	const flushing = flushTasks()
	// Navigate on with preloaded data before the first fetch resolves.
	setPreloadedNavigationData('/docs/secrets', {
		docDetail: createDoc('secrets'),
	})
	expect(docData.read(handle, '/docs/secrets').data?.slug).toBe('secrets')
	deferred.resolve(createDoc('memory'))
	await flushing
	// No update for the abandoned location, and the current one is untouched.
	expect(getUpdateCount()).toBe(0)
	expect(docData.read(handle, '/docs/secrets')).toEqual({
		kind: 'ready',
		data: createDoc('secrets'),
		stale: false,
		error: null,
	})
})

test('pending status is a visually hidden live region', async () => {
	const html = await renderToString(renderRoutePendingStatus())
	expect(html).toContain('role="status"')
	expect(html).toContain('Loading…')
})
