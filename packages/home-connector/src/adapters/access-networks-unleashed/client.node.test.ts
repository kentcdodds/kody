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

type FetchHandler = (
	url: string,
	init: RequestInit | undefined,
) => Promise<Response> | Response | null | undefined

function loginHandler(): FetchHandler {
	return (href, init) => {
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://unleashed.local/admin/wsg/login.jsp',
			})
		}
		if (init?.method === 'GET' && href.includes('username=admin')) {
			return response(null, {
				status: 302,
				headers: {
					HTTP_X_CSRF_TOKEN: 'csrf-token',
					'set-cookie': 'JSESSIONID=abc; Path=/admin',
				},
				url: href,
			})
		}
		return null
	}
}

function installFetch(...handlers: Array<FetchHandler>) {
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		for (const handler of handlers) {
			const result = await handler(href, init)
			if (result) return result
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch
	return fetchMock
}

test('request posts a fully formed ajax-request envelope to _cmdstat.jsp', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><system name="Unleashed" version="200.15"/></ajax-response>',
			)
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	const result = await client.request({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<sysinfo/>',
	})

	expect(result.action).toBe('getstat')
	expect(result.comp).toBe('system')
	expect(result.updater).toMatch(/^system\.\d+\.[a-z0-9]+$/)
	expect(result.xml).toContain('<system')
	expect(result.parsed).toEqual({
		'ajax-response': {
			system: {
				'@name': 'Unleashed',
				'@version': '200.15',
			},
		},
	})

	const cmdCall = fetchMock.mock.calls.find(([url]) =>
		String(url).endsWith('/_cmdstat.jsp'),
	)
	const body = String(cmdCall?.[1]?.body ?? '')
	expect(body.startsWith('<ajax-request')).toBe(true)
	expect(body).toContain("action='getstat'")
	expect(body).toContain("comp='system'")
	expect(body).toContain('<sysinfo/>')
	expect(body).toMatch(/updater='system\.\d+\.[a-z0-9]+'/)
	expect(new Headers(cmdCall?.[1]?.headers).get('Content-Type')).toBe(
		'text/xml',
	)
})

test('request honors a caller-supplied updater', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			return response('<ajax-response><ok/></ajax-response>')
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	const result = await client.request({
		action: 'docmd',
		comp: 'stamgr',
		xmlBody: "<xcmd cmd='reset'/>",
		updater: 'reset.42',
	})

	expect(result.updater).toBe('reset.42')
	const cmdCall = fetchMock.mock.calls.find(([url]) =>
		String(url).endsWith('/_cmdstat.jsp'),
	)
	const body = String(cmdCall?.[1]?.body ?? '')
	expect(body).toContain("updater='reset.42'")
	expect(body).toContain("action='docmd'")
})

test('request reauthenticates once on 302 for getstat actions', async () => {
	const config = createConfig()
	let cmdAttempts = 0
	const fetchMock = installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			cmdAttempts += 1
			if (cmdAttempts === 1) {
				return response(null, { status: 302 })
			}
			return response('<ajax-response><ok/></ajax-response>')
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	const result = await client.request({
		action: 'getstat',
		comp: 'system',
		xmlBody: '<sysinfo/>',
	})

	expect(result.parsed).toEqual({
		'ajax-response': { ok: null },
	})
	const loginAttempts = fetchMock.mock.calls.filter((call) =>
		String(call[0]).includes('username=admin'),
	)
	expect(loginAttempts).toHaveLength(2)
})

test('request does not retry mutating actions after a 302', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(null, { status: 302 })
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await expect(
		client.request({
			action: 'docmd',
			comp: 'stamgr',
			xmlBody: "<xcmd cmd='reset'/>",
		}),
	).rejects.toThrow('redirected during a command')

	const loginAttempts = fetchMock.mock.calls.filter((call) =>
		String(call[0]).includes('username=admin'),
	)
	expect(loginAttempts).toHaveLength(1)
})

test('concurrent requests share one login flow', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return new Promise<Response>((resolve) => {
				setTimeout(() => {
					resolve(
						response(null, {
							status: 200,
							url: 'https://unleashed.local/admin/wsg/login.jsp',
						}),
					)
				}, 5)
			})
		}
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><client mac="aa:bb:cc:dd:ee:ff"/></ajax-response>',
			)
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await Promise.all([
		client.request({
			action: 'getstat',
			comp: 'stamgr',
			xmlBody: "<client LEVEL='1'/>",
		}),
		client.request({
			action: 'getstat',
			comp: 'stamgr',
			xmlBody: "<client LEVEL='1'/>",
		}),
	])

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
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
			})
		}
		if (init?.method === 'GET' && href.includes('username=admin')) {
			if (rejectedLogin) {
				rejectedLogin = false
				return response(null, { status: 200, url: href })
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
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
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

	await expect(
		client.request({
			action: 'getstat',
			comp: 'stamgr',
			xmlBody: "<client LEVEL='1'/>",
		}),
	).rejects.toThrow('login was rejected')
	const result = await client.request({
		action: 'getstat',
		comp: 'stamgr',
		xmlBody: "<client LEVEL='1'/>",
	})
	expect(result.parsed).toEqual({
		'ajax-response': {
			client: { '@mac': 'aa:bb:cc:dd:ee:ff' },
		},
	})
})

test('request rejects xmsg error responses', async () => {
	const config = createConfig()
	installFetch(loginHandler(), (href) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			return response(
				'<ajax-response><xmsg error="1" lmsg="bad request"/></ajax-response>',
			)
		}
		return null
	})

	const client = createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	})
	await expect(
		client.request({
			action: 'docmd',
			comp: 'stamgr',
			xmlBody: '<bogus/>',
		}),
	).rejects.toThrow('rejected the command')
})
