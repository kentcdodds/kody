import { createServer, type IncomingMessage, type Server } from 'node:http'

import { handleNxCacheRequest } from './handle-request.ts'
import { createMemoryCacheStore } from './memory-store.ts'
import { type NxCacheStore } from './nx-cache-types.ts'

export type NxCacheRequestLog = {
	method: string
	pathname: string
	status: number
}

export type LocalNxCacheServer = {
	url: string
	token: string
	store: NxCacheStore
	requests: Array<NxCacheRequestLog>
	close(): Promise<void>
}

function collectBody(request: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Array<Buffer> = []
		request.on('data', (chunk: Buffer) => {
			chunks.push(chunk)
		})
		request.on('end', () => {
			resolve(Buffer.concat(chunks))
		})
		request.on('error', reject)
	})
}

function headersFromIncoming(request: IncomingMessage): Headers {
	const headers = new Headers()
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry)
			continue
		}
		headers.set(name, value)
	}
	return headers
}

export async function startLocalNxCacheServer(options?: {
	token?: string
	store?: NxCacheStore
}): Promise<LocalNxCacheServer> {
	const token = options?.token ?? 'nx-cache-smoke-token'
	const store = options?.store ?? createMemoryCacheStore()
	const requests: Array<NxCacheRequestLog> = []

	const server: Server = createServer(async (incoming, outgoing) => {
		const host = incoming.headers.host ?? '127.0.0.1'
		const url = new URL(incoming.url ?? '/', `http://${host}`)
		const method = incoming.method ?? 'GET'
		const hasBody = method !== 'GET' && method !== 'HEAD'
		const body = hasBody ? await collectBody(incoming) : null
		const requestBody =
			body && body.byteLength > 0
				? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
				: undefined
		const request = new Request(url, {
			method,
			headers: headersFromIncoming(incoming),
			body: requestBody instanceof ArrayBuffer ? requestBody : undefined,
		})
		const response = await handleNxCacheRequest(
			request,
			{ CACHE_ACCESS_TOKEN: token, BUILD_COMMIT: 'smoke' },
			store,
		)
		requests.push({ method, pathname: url.pathname, status: response.status })
		outgoing.statusCode = response.status
		response.headers.forEach((value, name) => {
			outgoing.setHeader(name, value)
		})
		outgoing.end(Buffer.from(await response.arrayBuffer()))
	})

	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (!address || typeof address === 'string') {
		throw new Error('Failed to bind the local Nx cache server')
	}

	return {
		url: `http://127.0.0.1:${address.port}`,
		token,
		store,
		requests,
		close() {
			return new Promise((resolve, reject) => {
				server.close((error) => {
					if (error) reject(error)
					else resolve()
				})
			})
		},
	}
}
