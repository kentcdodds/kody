import { expect, test } from 'vitest'
import { CloudflareCustomHostnamesClient } from './cloudflare-custom-hostnames-client.ts'

const zoneId = 'packageappzoneid123'
const token = 'custom-hostnames-token'

function mockFetcher(
	handler: (request: Request) => Response | Promise<Response>,
): Fetcher {
	return {
		fetch(input: RequestInfo | URL, init?: RequestInit) {
			const request = new Request(input, init)
			return Promise.resolve(handler(request))
		},
		connect() {
			throw new Error('connect is not used')
		},
	} as Fetcher
}

test('custom hostname client adds, reads, and deletes with the dedicated token', async () => {
	const seen: Array<{
		method: string
		url: string
		authorization: string | null
		body: string
	}> = []
	const client = new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
		PACKAGE_APP_ZONE_ID: zoneId,
		fetcher: mockFetcher(async (request) => {
			seen.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.get('authorization'),
				body: await request.text(),
			})
			const id = request.url.endsWith('/custom_hostnames')
				? 'hostname-1'
				: 'hostname-1'
			return Response.json({
				success: true,
				result: {
					id,
					hostname: 'app.customer.example',
					status: request.method === 'DELETE' ? 'deleted' : 'pending',
					ssl: { status: 'pending_validation' },
				},
			})
		}),
	})

	const added = await client.addCustomHostname({
		hostname: 'App.Customer.Example',
	})
	expect(added).toEqual({
		id: 'hostname-1',
		hostname: 'app.customer.example',
		hostnameStatus: 'pending',
		sslStatus: 'pending_validation',
	})

	const fetched = await client.getCustomHostname({ id: 'hostname-1' })
	expect(fetched.hostnameStatus).toBe('pending')

	const deleted = await client.deleteCustomHostname({ id: 'hostname-1' })
	expect(deleted.hostnameStatus).toBe('deleted')

	expect(
		seen.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`),
	).toEqual([
		`POST /client/v4/zones/${zoneId}/custom_hostnames`,
		`GET /client/v4/zones/${zoneId}/custom_hostnames/hostname-1`,
		`DELETE /client/v4/zones/${zoneId}/custom_hostnames/hostname-1`,
	])
	expect(seen.every((entry) => entry.authorization === `Bearer ${token}`)).toBe(
		true,
	)
	expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
		hostname: 'app.customer.example',
		ssl: { method: 'http', type: 'dv' },
	})
	expect(seen[1]?.body).toBe('')
})

test('custom hostname client refuses a missing token or zone', () => {
	expect(
		() =>
			new CloudflareCustomHostnamesClient({
				CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: '  ',
				PACKAGE_APP_ZONE_ID: zoneId,
			}),
	).toThrow(/CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN/)
	expect(
		() =>
			new CloudflareCustomHostnamesClient({
				CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN: token,
				PACKAGE_APP_ZONE_ID: '',
			}),
	).toThrow(/PACKAGE_APP_ZONE_ID/)
})
