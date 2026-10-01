import { type HttpHandler } from 'msw'
import { setupServer } from 'msw/node'

export type MswNodeServerOptions = {
	/**
	 * Shared helper option name (matches Workers experimental `defineNetwork`).
	 * Mapped to MSW node `server.listen({ onUnhandledRequest })`.
	 */
	onUnhandledFrame?: 'error' | 'warn' | 'bypass'
}

export function createMswNodeServer(
	handlers: Array<HttpHandler> = [],
	options: MswNodeServerOptions = {},
) {
	const server = setupServer(...handlers)
	const onUnhandledRequest = options.onUnhandledFrame ?? 'error'
	server.listen({ onUnhandledRequest })

	return {
		server,
		close() {
			server.close()
		},
		resetHandlers() {
			server.resetHandlers()
		},
		use(...nextHandlers: Array<HttpHandler>) {
			server.use(...nextHandlers)
		},
		[Symbol.dispose]() {
			server.close()
		},
	}
}
