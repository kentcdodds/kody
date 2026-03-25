import { http, passthrough, type RequestHandler } from 'msw'
import { rokuHandlers } from './roku.ts'

const passthroughHandlers: Array<RequestHandler> = [
	http.all('*/__mocks/*', () => passthrough()),
]

export const mswHandlers: Array<RequestHandler> = [
	...passthroughHandlers,
	...rokuHandlers,
]
