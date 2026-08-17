import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { expect, test } from 'vitest'
import {
	buildMcpClientIdMetadataDocument,
	mcpClientIdMetadataPath,
} from './client-id-metadata.ts'

async function workerFetch(request: Request) {
	const ctx = createExecutionContext()
	const response = await exports.default.fetch(request, env, ctx)
	await waitOnExecutionContext(ctx)
	return response
}

test('worker serves Kody CIMD before the OAuth provider wrapper', async () => {
	const origin = 'https://kody.codes'
	const documentUrl = `${origin}${mcpClientIdMetadataPath}`
	const response = await workerFetch(new Request(documentUrl))
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('application/json')
	await expect(response.json()).resolves.toEqual(
		buildMcpClientIdMetadataDocument(origin),
	)
})
