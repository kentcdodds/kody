import { expect, test } from 'vitest'
import { http, HttpResponse } from 'msw'
import { createMswNodeServer } from '#worker/test-support/msw-node-server.ts'
import { startCloudflareMock } from '#worker/test-support/cloudflare-mock-server.ts'
import {
	createCloudflareRestClient,
	CloudflareRestClient,
} from './cloudflare-rest-client.ts'

test('Cloudflare REST clients read mock responses, enforce API paths, and send JSON bodies', async () => {
	const token = 'cloudflare-client-env-token'
	await using mock = await startCloudflareMock(token)
	const directClient = new CloudflareRestClient({
		apiToken: mock.token,
		baseUrl: mock.origin,
	})
	const accountsResponse = await directClient.rawRequest({
		method: 'GET',
		path: '/client/v4/accounts',
	})
	expect(accountsResponse.status).toBe(200)
	const accountsBody = accountsResponse.body as {
		success?: boolean
		result?: Array<{ id?: string }>
	}
	expect(accountsBody.success).toBe(true)
	expect(
		accountsBody.result?.some(
			(account) => account.id === 'cf_account_mock_123',
		),
	).toBe(true)

	const envClient = createCloudflareRestClient({
		CLOUDFLARE_API_TOKEN: mock.token,
		CLOUDFLARE_API_BASE_URL: mock.origin,
	} as Pick<Env, 'CLOUDFLARE_API_TOKEN' | 'CLOUDFLARE_API_BASE_URL'>)
	const verifyResponse = await envClient.rawRequest({
		method: 'GET',
		path: '/client/v4/user/tokens/verify',
	})
	expect(verifyResponse.status).toBe(200)
	await expect(
		envClient.rawRequest({
			method: 'GET',
			path: '/zones',
		}),
	).rejects.toThrow('path must start with `/client/v4/`')

	let capturedRequest: Request | null = null

	using _server = createMswNodeServer([
		http.patch(
			'https://api.cloudflare.test/client/v4/zones/example-zone-id/settings/always_online',
			async ({ request }) => {
				capturedRequest = request.clone()
				return HttpResponse.json({ success: true, result: null })
			},
		),
	])

	const patchClient = new CloudflareRestClient({
		apiToken: 'patch-token',
		baseUrl: 'https://api.cloudflare.test',
	})
	const patchResponse = await patchClient.rawRequest({
		method: 'PATCH',
		path: '/client/v4/zones/example-zone-id/settings/always_online',
		body: { value: 'on' },
	})

	expect(patchResponse.status).toBe(200)
	expect(capturedRequest).not.toBeNull()
	expect(capturedRequest?.method).toBe('PATCH')
	expect(capturedRequest?.headers.get('authorization')).toBe(
		'Bearer patch-token',
	)
	expect(capturedRequest?.headers.get('content-type')).toBe('application/json')
	expect(await capturedRequest?.text()).toBe('{"value":"on"}')
})
