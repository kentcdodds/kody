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
	using _env = createTemporaryEnv({
		HOME_CONNECTOR_ID: 'default',
		WORKER_BASE_URL: 'http://localhost:3742',
		ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS: '192.168.10.88/32',
		ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: 'true',
	})
	return loadHomeConnectorConfig()
}

function createController() {
	return {
		controllerId: 'unleashed-1',
		name: 'Access Networks Unleashed',
		host: 'https://unleashed.local',
		loginUrl: 'https://unleashed.local/admin/wsg/login.jsp',
		lastSeenAt: '2026-05-03T19:00:00.000Z',
		rawDiscovery: null,
		adopted: true,
		username: 'admin',
		password: 'password',
		lastAuthenticatedAt: null,
		lastAuthError: null,
	}
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

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).unblockClient('aa:bb:cc:dd:ee:ff')

	const updateBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='updobj'"))
	expect(updateBody).toContain("custom='preserve'")
	expect(updateBody).toContain("<allow mac='77:88:99:aa:bb:cc' type='single'/>")
	expect(updateBody).toContain("<deny mac='11:22:33:44:55:66' type='single'/>")
	expect(updateBody).not.toContain("<deny mac='aa:bb:cc:dd:ee:ff'")
})

test('post XML redirects reset session and stop after one reauthentication', async () => {
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
		createAccessNetworksUnleashedAjaxClient({
			config,
			controller: createController(),
		}).listWlans(),
	).rejects.toThrow('redirected after reauthentication')
})

test('mutating post XML does not retry after session redirect', async () => {
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
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(null, { status: 302 })
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	await expect(
		createAccessNetworksUnleashedAjaxClient({
			config,
			controller: createController(),
		}).restartAccessPoint('24:79:de:ad:be:ef'),
	).rejects.toThrow('redirected during a command')

	const loginAttempts = fetchMock.mock.calls.filter((call) =>
		String(call[0]).includes('username=admin'),
	)
	expect(loginAttempts).toHaveLength(1)
})

test('concurrent reads share one login flow', async () => {
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
			await new Promise((resolve) => setTimeout(resolve, 5))
			return response(null, {
				status: 200,
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><client mac="aa:bb:cc:dd:ee:ff"/></ajax-response>',
			)
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch
	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})

	await Promise.all([client.listClients(), client.listClients()])

	const loginAttempts = fetchMock.mock.calls.filter((call) =>
		String(call[0]).includes('username=admin'),
	)
	expect(loginAttempts).toHaveLength(1)
})

test('failed login does not leave a partial session', async () => {
	const config = createConfig()
	let rejectedLogin = true
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
			if (rejectedLogin) {
				rejectedLogin = false
				return response(null, {
					status: 200,
					url: href,
				})
			}
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
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><client mac="aa:bb:cc:dd:ee:ff"/></ajax-response>',
			)
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch
	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})

	await expect(client.listClients()).rejects.toThrow('login was rejected')
	await expect(client.listClients()).resolves.toEqual([
		expect.objectContaining({
			mac: 'aa:bb:cc:dd:ee:ff',
		}),
	])
})
