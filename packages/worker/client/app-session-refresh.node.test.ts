import { type Handle } from 'remix/ui'
import { renderToString } from 'remix/ui/server'
import { expect, test, vi } from 'vitest'

type QueueTask = Parameters<Handle['queueTask']>[0]

const { fetchSessionInfoMock, navigationListeners, queuedSessionResponses } =
	vi.hoisted(() => {
		const navigationListeners: Array<() => void> = []
		const queuedSessionResponses: Array<{ email: string } | null> = []
		const fetchSessionInfoMock = vi.fn(async () => {
			return queuedSessionResponses.shift() ?? null
		})

		return {
			fetchSessionInfoMock,
			navigationListeners,
			queuedSessionResponses,
		}
	})

vi.mock('./client-router.tsx', () => ({
	routerEvents: new EventTarget(),
	listenToRouterNavigation: (_handle: Handle, listener: () => void) => {
		navigationListeners.push(listener)
	},
	getPathname: () => '/',
	navigate: () => {
		return
	},
	Router: () => () => null,
}))

vi.mock('./session.ts', () => ({
	fetchSessionInfo: fetchSessionInfoMock,
}))

const { App } = await import('./app.tsx')

async function runNextTask(tasks: Array<QueueTask>, aborted: boolean) {
	const task = tasks.shift()
	expect(task).toBeDefined()
	const controller = new AbortController()
	if (aborted) controller.abort()
	await task!(controller.signal)
}

test('aborted refresh does not erase a ready authenticated session', async () => {
	navigationListeners.length = 0
	queuedSessionResponses.length = 0
	const sessionEmail = 'signed-in@example.com'
	queuedSessionResponses.push({ email: sessionEmail }, null)

	const queuedTasks: Array<QueueTask> = []
	const handle = {
		queueTask(task: QueueTask) {
			queuedTasks.push(task)
		},
		async update() {
			return new AbortController().signal
		},
		on() {
			return
		},
	} as unknown as Handle

	const render = App(handle)
	expect(navigationListeners).toHaveLength(1)

	// Initial bootstrap task enqueues the session fetch.
	await runNextTask(queuedTasks, false)
	await runNextTask(queuedTasks, false)

	const authenticatedUi = await renderToString(render())
	expect(authenticatedUi).toContain('href="/account/secrets"')
	expect(authenticatedUi).toContain(sessionEmail)
	expect(authenticatedUi).toContain('<form method="post" action="/logout"')

	// Re-run refresh via navigation, then abort in-flight fetch.
	navigationListeners[0]!()
	await runNextTask(queuedTasks, true)

	const uiAfterAbort = await renderToString(render())
	expect(uiAfterAbort).toContain('href="/account/secrets"')
	expect(uiAfterAbort).toContain(sessionEmail)
	expect(uiAfterAbort).toContain('<form method="post" action="/logout"')
})
