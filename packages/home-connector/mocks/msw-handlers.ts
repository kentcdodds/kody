import { http, passthrough, type RequestHandler } from 'msw'
import { lutronHandlers } from './lutron.ts'
import { rokuHandlers } from './roku.ts'
import { samsungTvHandlers } from './samsung-tv.ts'

const loopbackRequestPattern =
	/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//

const passthroughHandlers: Array<RequestHandler> = [
	http.all(loopbackRequestPattern, () => passthrough()),
	http.all('*/__mocks/*', () => passthrough()),
]

export const mswHandlers: Array<RequestHandler> = [
	...passthroughHandlers,
	...lutronHandlers,
	...rokuHandlers,
	...samsungTvHandlers,
]
