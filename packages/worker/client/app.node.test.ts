import { expect, test, vi } from 'vitest'
import { type Handle } from 'remix/ui'
import { App, appMainOwnsItsGutters } from './app.tsx'
import * as clientRouter from './client-router.tsx'
import { RouterLocationProvider } from './router-location.tsx'
import * as session from './session.ts'

const signedInSession: session.SessionInfo = {
	email: 'kody@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	username: 'kody',
	avatarUrl: null,
	roles: ['user'],
	permissions: [],
	featureFlags: {
		'demo-indicator': false,
		'compact-mcp-server-instructions': false,
		'compute-overage-charging': true,
		'package-share-grants': false,
	},
}

async function flushQueuedTasks(
	queuedTasks: Array<(signal?: AbortSignal) => unknown>,
) {
	while (queuedTasks.length > 0) {
		const tasks = queuedTasks.splice(0)
		await Promise.all(tasks.map((task) => task(new AbortController().signal)))
	}
}

function mountApp(input: {
	embeddedSession?: session.SessionInfo | null
	navigationListeners: Array<() => void>
}) {
	const queuedTasks: Array<(signal?: AbortSignal) => unknown> = []
	const abort = new AbortController()
	vi.spyOn(clientRouter, 'listenToRouterNavigation').mockImplementation(
		(_handle, listener) => {
			input.navigationListeners.push(listener)
		},
	)
	vi.spyOn(clientRouter, 'listenToRouterNavigationEnd').mockImplementation(
		() => {},
	)
	vi.spyOn(clientRouter, 'listenToRouterMutations').mockImplementation(() => {})

	App({
		props:
			input.embeddedSession === undefined
				? {}
				: { embeddedSession: input.embeddedSession },
		signal: abort.signal,
		context: {
			get(provider: unknown) {
				if (provider === RouterLocationProvider) {
					return { url: '/', ssrUrl: '/' }
				}
				throw new Error('context not available')
			},
			set() {},
		},
		queueTask(task: (signal?: AbortSignal) => unknown) {
			queuedTasks.push(task)
		},
		update: vi.fn(() => Promise.resolve(abort.signal)),
	} as unknown as Handle<{ embeddedSession?: session.SessionInfo | null }>)

	return { abort, queuedTasks }
}

test('App skips the post-hydration /session fetch when the document embedded a session, fetches when it did not, and still refreshes after the navigation throttle', async () => {
	const previousDocument = globalThis.document
	const previousWindow = globalThis.window
	const fetchSpy = vi
		.spyOn(session, 'fetchSessionInfo')
		.mockResolvedValue(signedInSession)

	globalThis.document = {
		addEventListener: vi.fn(),
		referrer: '',
	} as unknown as Document
	globalThis.window = {
		location: {
			href: 'https://kody.local/',
			pathname: '/',
			search: '',
			hash: '',
		},
		history: { state: null, replaceState: vi.fn() },
		addEventListener: vi.fn(),
	} as unknown as Window & typeof globalThis

	const aborts: Array<AbortController> = []
	try {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-09-02T18:00:00.000Z'))

		const embeddedNavigations: Array<() => void> = []
		const embedded = mountApp({
			embeddedSession: signedInSession,
			navigationListeners: embeddedNavigations,
		})
		aborts.push(embedded.abort)
		await flushQueuedTasks(embedded.queuedTasks)
		expect(fetchSpy).not.toHaveBeenCalled()

		for (const listener of embeddedNavigations) listener()
		await flushQueuedTasks(embedded.queuedTasks)
		expect(fetchSpy).not.toHaveBeenCalled()

		vi.setSystemTime(new Date('2026-09-02T18:00:30.000Z'))
		for (const listener of embeddedNavigations) listener()
		await flushQueuedTasks(embedded.queuedTasks)
		expect(fetchSpy).toHaveBeenCalledTimes(1)

		session.queueSessionRefresh()
		await flushQueuedTasks(embedded.queuedTasks)
		expect(fetchSpy).toHaveBeenCalledTimes(2)

		const anonymousNavigations: Array<() => void> = []
		const anonymous = mountApp({
			embeddedSession: null,
			navigationListeners: anonymousNavigations,
		})
		aborts.push(anonymous.abort)
		await flushQueuedTasks(anonymous.queuedTasks)
		expect(fetchSpy).toHaveBeenCalledTimes(2)

		const missingNavigations: Array<() => void> = []
		const missing = mountApp({
			navigationListeners: missingNavigations,
		})
		aborts.push(missing.abort)
		await flushQueuedTasks(missing.queuedTasks)
		expect(fetchSpy).toHaveBeenCalledTimes(3)
	} finally {
		for (const abort of aborts) abort.abort()
		vi.useRealTimers()
		vi.restoreAllMocks()
		globalThis.document = previousDocument
		globalThis.window = previousWindow
	}
})

test('navigating away from a 404 restores main gutters on pages that still use them', () => {
	// SSR 404: the shared not-found page owns its padding, so `<main>`
	// must not add another inset.
	expect(
		appMainOwnsItsGutters({
			pathname: '/missing-page',
			notFound: true,
			onSsrUrl: true,
		}),
	).toBe(true)

	// Support is a matched route that still relies on `<main>` padding.
	// After SPA navigation the document still has notFound: true, but we
	// are no longer on the URL the server rendered.
	expect(
		appMainOwnsItsGutters({
			pathname: '/support',
			notFound: true,
			onSsrUrl: false,
		}),
	).toBe(false)
})

test('SSR 500 pages own main gutters the same way 404s do', () => {
	expect(
		appMainOwnsItsGutters({
			pathname: '/account',
			notFound: false,
			internalError: true,
			onSsrUrl: true,
		}),
	).toBe(true)
	expect(
		appMainOwnsItsGutters({
			pathname: '/support',
			notFound: false,
			internalError: true,
			onSsrUrl: false,
		}),
	).toBe(false)
})

test('explicit /404 and /500 pages own main gutters after SPA navigation', () => {
	expect(
		appMainOwnsItsGutters({
			pathname: '/404',
			notFound: false,
			onSsrUrl: false,
		}),
	).toBe(true)
	expect(
		appMainOwnsItsGutters({
			pathname: '/500',
			notFound: false,
			internalError: false,
			onSsrUrl: false,
		}),
	).toBe(true)
})
