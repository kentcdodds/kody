import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http'
import { expect, test } from 'vitest'
import { probeCloudflareMockReady } from './cloudflare-mock-server.ts'

const token = 'cloudflare-mock-ready-token'

test('Cloudflare mock readiness probe retries 503s and empty bodies until Durable Objects answer', async () => {
	await using server = await startSequenceServer([
		{ status: 503, body: 'overloaded' },
		{ status: 200, body: '' },
		{ status: 200, body: 'not-json' },
		{
			status: 200,
			body: JSON.stringify({ service: 'cloudflare', authorized: false }),
		},
		{
			status: 200,
			body: JSON.stringify({
				service: 'cloudflare',
				authorized: true,
			}),
		},
		{
			status: 200,
			body: JSON.stringify({
				service: 'cloudflare',
				authorized: true,
				artifactRepoCount: 0,
			}),
		},
	])

	const statuses = [
		await probeCloudflareMockReady(server.origin, token),
		await probeCloudflareMockReady(server.origin, token),
		await probeCloudflareMockReady(server.origin, token),
		await probeCloudflareMockReady(server.origin, token),
		await probeCloudflareMockReady(server.origin, token),
		await probeCloudflareMockReady(server.origin, token),
	]

	expect(statuses).toEqual([
		{ ready: false, reason: 'HTTP 503' },
		{ ready: false, reason: 'empty body' },
		{ ready: false, reason: 'invalid JSON' },
		{ ready: false, reason: 'unauthorized' },
		{ ready: false, reason: 'durable objects not ready' },
		{ ready: true },
	])
	expect(server.tokens).toEqual([token, token, token, token, token, token])
})

async function startSequenceServer(
	responses: Array<{ status: number; body: string }>,
) {
	const remaining = [...responses]
	const tokens: Array<string> = []
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? '/', 'http://127.0.0.1')
		tokens.push(url.searchParams.get('token') ?? '')
		const next = remaining.shift() ?? { status: 500, body: 'exhausted' }
		res.statusCode = next.status
		res.end(next.body)
	})
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (typeof address !== 'object' || address === null) {
		throw new Error('Readiness probe server did not bind a TCP port.')
	}
	return {
		origin: `http://127.0.0.1:${String(address.port)}`,
		tokens,
		async [Symbol.asyncDispose]() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()))
			})
		},
	}
}
