import { http, passthrough, type RequestHandler } from 'msw'
import { bondHandlers } from './bond.ts'
import { jellyfishHandlers } from './jellyfish.ts'
import { lutronHandlers } from './lutron.ts'
import { rokuHandlers } from './roku.ts'
import { samsungTvHandlers } from './samsung-tv.ts'
import { sonosHandlers } from './sonos.ts'
import { teslaGatewayHandlers } from './tesla-gateway.ts'
import { venstarHandlers } from './venstar.ts'

const loopbackRequestPattern =
	/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//

const passthroughHandlers: Array<RequestHandler> = [
	http.all(loopbackRequestPattern, () => passthrough()),
	http.all('*/__mocks/*', () => passthrough()),
]

export const mswHandlers: Array<RequestHandler> = [
	...passthroughHandlers,
	...bondHandlers,
	...jellyfishHandlers,
	...lutronHandlers,
	...rokuHandlers,
	...sonosHandlers,
	...samsungTvHandlers,
	...teslaGatewayHandlers,
	...venstarHandlers,
]
