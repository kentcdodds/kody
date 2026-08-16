import { request as httpRequest } from 'node:http'

import { expect, test } from 'vitest'

import { MAX_ARTIFACT_BYTES } from './handle-request.ts'
import { startLocalNxCacheServer } from './local-server.ts'

const HASH = '0123456789abcdef0123456789abcdef'

test('local server rejects oversized Content-Length before buffering the body', async () => {
	await using server = {
		...(await startLocalNxCacheServer()),
		async [Symbol.asyncDispose]() {
			await this.close()
		},
	}

	const status = await new Promise<number>((resolve, reject) => {
		const url = new URL(`${server.url}/v1/cache/${HASH}`)
		const req = httpRequest(
			{
				hostname: url.hostname,
				port: url.port,
				path: url.pathname,
				method: 'PUT',
				headers: {
					authorization: `Bearer ${server.token}`,
					'content-type': 'application/octet-stream',
					'content-length': String(MAX_ARTIFACT_BYTES + 1),
				},
			},
			(response) => {
				response.resume()
				response.on('end', () => {
					resolve(response.statusCode ?? 0)
				})
			},
		)
		req.on('error', reject)
		req.end(Buffer.from([1]))
	})

	expect(status).toBe(413)
	expect(
		server.requests.some(
			(entry) => entry.method === 'PUT' && entry.status === 413,
		),
	).toBe(true)
})
