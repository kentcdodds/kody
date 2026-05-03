import { afterEach, expect, test, vi } from 'vitest'
import { createAccessNetworksUnleashedAjaxClient } from './client.ts'
import { loadHomeConnectorConfig } from '../../config.ts'

const originalFetch = globalThis.fetch

function createTemporaryEnv(values: Record<string, string | undefined>) {
	const previousValues = Object.fromEntries(
		Object.keys(values).map((key) => [key, process.env[key]]),
	)

	for (const [key, value] of Object.entries(values)) {
		if (typeof value === 'undefined') {
			delete process.env[key]
			continue
		}
		process.env[key] = value
	}

	return {
		[Symbol.dispose]: () => {
			for (const [key, value] of Object.entries(previousValues)) {
				if (typeof value === 'undefined') {
					delete process.env[key]
					continue
				}
				process.env[key] = value
			}
		},
	}
}

function response(
	body: string | null,
	init: ResponseInit & { url?: string } = {},
) {
	const output = new Response(body, init)
	Object.defineProperty(output, 'url', {
		value: init.url ?? 'https://unleashed.local/admin/wsg',
	})
	return output
}

function createConfig() {
	process.env.HOME_CONNECTOR_ID = 'default'
	process.env.WORKER_BASE_URL = 'http://localhost:3742'
	process.env.ACCESS_NETWORKS_UNLEASHED_HOST = 'https://unleashed.local'
	process.env.ACCESS_NETWORKS_UNLEASHED_USERNAME = 'admin'
	process.env.ACCESS_NETWORKS_UNLEASHED_PASSWORD = 'password'
	process.env.ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS = 'true'
	return loadHomeConnectorConfig()
}

afterEach(() => {
	globalThis.fetch = originalFetch
})

test('unblock client preserves unrelated system ACL XML', async () => {
	using _env = createTemporaryEnv({})
	const config = createConfig()
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		if (init?.method === 'HEAD' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'HEAD' && href.includes('username=admin')) {
			return response(null, {
				status: 302,
				headers: {
					HTTP_X_CSRF_TOKEN: 'csrf-token',
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: href,
			})
		}
		if (init?.method === 'HEAD' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("action='getconf'")) {
				return response(
					[
						'<ajax-response><acl-list>',
						"<acl id='1' name='System' description='Keep me' default-mode='allow' EDITABLE='false' custom='preserve'>",
						"<deny mac='aa:bb:cc:dd:ee:ff' type='single'/>",
						"<deny mac='11:22:33:44:55:66' type='single'/>",
						"<allow mac='77:88:99:aa:bb:cc' type='single'/>",
						'</acl>',
						'</acl-list></ajax-response>',
					].join(''),
				)
			}
			return response('<ajax-response><xmsg status="0"/></ajax-response>')
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	await createAccessNetworksUnleashedAjaxClient({ config }).unblockClient(
		'aa:bb:cc:dd:ee:ff',
	)

	const updateBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='updobj'"))
	expect(updateBody).toContain("custom='preserve'")
	expect(updateBody).toContain("<allow mac='77:88:99:aa:bb:cc' type='single'/>")
	expect(updateBody).toContain("<deny mac='11:22:33:44:55:66' type='single'/>")
	expect(updateBody).not.toContain("<deny mac='aa:bb:cc:dd:ee:ff'")
})

test('post XML redirects reset session and stop after one reauthentication', async () => {
	using _env = createTemporaryEnv({})
	const config = createConfig()
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		if (init?.method === 'HEAD' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'HEAD' && href.includes('username=admin')) {
			return response(null, {
				status: 302,
				headers: {
					HTTP_X_CSRF_TOKEN: 'csrf-token',
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: href,
			})
		}
		if (init?.method === 'HEAD' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (href.endsWith('/_conf.jsp')) {
			return response(null, { status: 302 })
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	await expect(
		createAccessNetworksUnleashedAjaxClient({ config }).listWlans(),
	).rejects.toThrow('redirected after reauthentication')
})
