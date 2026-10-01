import { type HttpHandler } from 'msw'

type MswWorkerServerOptions = {
	onUnhandledFrame?: 'error' | 'warn' | 'bypass'
}

export function createMswWorkerServer(
	handlers: Array<HttpHandler> = [],
	options: MswWorkerServerOptions = {},
) {
	let activeHandlers = [...handlers]
	const originalFetch = globalThis.fetch
	const onUnhandledFrame = options.onUnhandledFrame ?? 'error'
	let requestSequence = 0

	const interceptedFetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init)
		for (const handler of activeHandlers) {
			const result = await handler.run({
				request: request.clone() as Parameters<
					HttpHandler['run']
				>[0]['request'],
				requestId: `msw-worker-${++requestSequence}`,
			})
			if (result?.response) return result.response
		}

		if (onUnhandledFrame === 'error') {
			throw new Error(`Unhandled ${request.method} request to ${request.url}.`)
		}
		if (onUnhandledFrame === 'warn') {
			console.warn(`Unhandled ${request.method} request to ${request.url}.`)
		}
		return originalFetch(input, init)
	}

	globalThis.fetch = interceptedFetch

	function resetHandlers() {
		for (const handler of activeHandlers) handler.reset()
		activeHandlers = [...handlers]
	}

	function use(...nextHandlers: Array<HttpHandler>) {
		activeHandlers = [...nextHandlers, ...activeHandlers]
	}

	function close() {
		globalThis.fetch = originalFetch
	}

	return {
		server: { use, resetHandlers, close },
		close,
		resetHandlers,
		use,
		[Symbol.dispose]: close,
	}
}
