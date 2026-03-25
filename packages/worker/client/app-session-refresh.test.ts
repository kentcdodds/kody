import { expect, test, vi } from 'vitest'
import { type Handle } from 'remix/component'

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

function collectTextContent(value: unknown): Array<string> {
	if (typeof value === 'string') {
		return [value]
	}
	if (
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		value == null
	) {
		return []
	}
	if (Array.isArray(value)) {
		return value.flatMap((entry) => collectTextContent(entry))
	}
	if (typeof value === 'object') {
		const props =
			'props' in value &&
			value.props &&
			typeof value.props === 'object' &&
			'children' in value.props
				? value.props.children
				: undefined
		return collectTextContent(props)
	}
	return []
}

function renderToText(value: unknown) {
	return collectTextContent(value).join(' ')
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

	const authenticatedUi = renderToText(render())
	expect(authenticatedUi).toContain('signed-in@example.com')
	expect(authenticatedUi).toContain('Log out')

	// Re-run refresh via navigation, then abort in-flight fetch.
	navigationListeners[0]!()
	await runNextTask(queuedTasks, true)

	const uiAfterAbort = renderToText(render())
	expect(uiAfterAbort).toContain('signed-in@example.com')
	expect(uiAfterAbort).toContain('Log out')
	expect(uiAfterAbort).not.toContain('Login')
	expect(uiAfterAbort).not.toContain('Signup')
})
