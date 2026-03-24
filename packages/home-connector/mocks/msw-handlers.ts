import { type RequestHandler } from 'msw'
import { rokuHandlers } from './roku.ts'

export const mswHandlers: Array<RequestHandler> = [...rokuHandlers]
