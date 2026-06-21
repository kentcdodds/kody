import { type HttpHandler } from 'msw'
import { setupServer, type SetupServerApi } from 'msw/node'

export type MswNodeServerOptions = {
	onUnhandledRequest?: 'error' | 'warn' | 'bypass'
}

export function createMswNodeServer(
	handlers: Array<HttpHandler> = [],
	options: MswNodeServerOptions = {},
) {
	const server = setupServer(...handlers)
	const onUnhandledRequest = options.onUnhandledRequest ?? 'error'

	return {
		server,
		start() {
			server.listen({ onUnhandledRequest })
		},
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

export async function withMswNodeServer<T>(
	handlers: Array<HttpHandler>,
	run: (server: SetupServerApi) => Promise<T>,
	options: MswNodeServerOptions = {},
): Promise<T> {
	const { server, start, close } = createMswNodeServer(handlers, options)
	start()
	try {
		return await run(server)
	} finally {
		close()
	}
}
