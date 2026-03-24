/// <reference types="bun" />
import { expect, mock, test } from 'bun:test'
import { type Handle } from 'remix/component'

type QueueTask = Parameters<Handle['queueTask']>[0]

const navigationListeners: Array<() => void> = []
const queuedSessionResponses: Array<{ email: string } | null> = []
const fetchSessionInfoMock = mock(async () => {
	return queuedSessionResponses.shift() ?? null
})

mock.module('./client-router.tsx', () => ({
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

mock.module('./session.ts', () => ({
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
	queuedSessionResponses.push({ email: 'signed-in@example.com' }, null)

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

	const authenticatedUi = Bun.inspect(render())
	expect(authenticatedUi).toContain('signed-in@example.com')
	expect(authenticatedUi).toContain('Log out')

	// Re-run refresh via navigation, then abort in-flight fetch.
	navigationListeners[0]!()
	await runNextTask(queuedTasks, true)

	const uiAfterAbort = Bun.inspect(render())
	expect(uiAfterAbort).toContain('signed-in@example.com')
	expect(uiAfterAbort).toContain('Log out')
	expect(uiAfterAbort).not.toContain('>Login<')
	expect(uiAfterAbort).not.toContain('>Signup<')
})
