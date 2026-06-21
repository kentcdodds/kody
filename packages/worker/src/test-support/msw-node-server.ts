import { type HttpHandler } from 'msw'
import { setupServer } from 'msw/node'

export type MswNodeServerOptions = {
	onUnhandledRequest?: 'error' | 'warn' | 'bypass'
}

export function createMswNodeServer(
	handlers: Array<HttpHandler> = [],
	options: MswNodeServerOptions = {},
) {
	const server = setupServer(...handlers)
	const onUnhandledRequest = options.onUnhandledRequest ?? 'error'
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
