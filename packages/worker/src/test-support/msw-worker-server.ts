import { FetchInterceptor } from '@mswjs/interceptors/fetch'
import { defineNetwork, InterceptorSource } from 'msw/experimental'
import { type HttpHandler } from 'msw'
import { type MswNodeServerOptions } from './msw-node-server.ts'

export function createMswWorkerServer(
	handlers: Array<HttpHandler> = [],
	options: MswNodeServerOptions = {},
) {
	const network = defineNetwork({
		sources: [
			new InterceptorSource({ interceptors: [new FetchInterceptor()] }),
		],
		handlers,
		onUnhandledFrame: options.onUnhandledFrame ?? 'error',
		context: { quiet: true },
	})

	network.enable()

	function close() {
		network.disable()
	}

	return {
		server: network,
		close,
		resetHandlers: network.resetHandlers,
		use: network.use,
		[Symbol.dispose]: close,
	}
}
