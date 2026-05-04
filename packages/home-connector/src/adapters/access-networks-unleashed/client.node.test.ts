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
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
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
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
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
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
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
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
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
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
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
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
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
		if (init?.method === 'GET' && href === 'https://unleashed.local') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://unleashed.local/',
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
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
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

test('list blocked clients returns deny entries from system ACL', async () => {
	const config = createConfig()
	installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("comp='acl-list'")) {
				return response(
					[
						'<ajax-response><acl-list>',
						"<acl id='1' name='System' default-mode='allow' EDITABLE='false'>",
						"<deny mac='aa:bb:cc:dd:ee:ff' type='single'/>",
						"<deny mac='11:22:33:44:55:66' type='single'/>",
						'</acl>',
						'</acl-list></ajax-response>',
					].join(''),
				)
			}
		}
		return null
	})

	const blocked = await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).listBlockedClients()
	expect(blocked).toHaveLength(2)
	expect(blocked.map((entry) => entry['mac'])).toEqual([
		'aa:bb:cc:dd:ee:ff',
		'11:22:33:44:55:66',
	])
})

test('get syslog extracts text from xmsg/res body', async () => {
	const config = createConfig()
	installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("xcmd='get-syslog'") || body.includes('get-syslog')) {
				return response(
					'<ajax-response><xmsg><res>line1\nline2</res></xmsg></ajax-response>',
				)
			}
		}
		return null
	})
	const syslog = await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).getSyslog()
	expect(syslog).toContain('line1')
	expect(syslog).toContain('line2')
})

test('list blocked clients ignores ACLs whose id is not 1', async () => {
	const config = createConfig()
	installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("comp='acl-list'")) {
				return response(
					[
						'<ajax-response><acl-list>',
						"<acl id='2' name='Custom' default-mode='deny'>",
						"<deny mac='aa:bb:cc:dd:ee:ff' type='single'/>",
						'</acl>',
						'</acl-list></ajax-response>',
					].join(''),
				)
			}
		}
		return null
	})

	const blocked = await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).listBlockedClients()
	expect(blocked).toEqual([])
})

test('set wlan password posts an updated wlansvc with a new passphrase', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("action='getconf'")) {
				return response(
					[
						'<ajax-response><wlansvc-list>',
						"<wlansvc id='1' name='Main' ssid='Main' encryption='wpa2'>",
						"<wpa cipher='aes' passphrase='oldpass' dynamic-psk='disabled'/>",
						'</wlansvc>',
						'</wlansvc-list></ajax-response>',
					].join(''),
				)
			}
			if (body.includes("action='updobj'")) {
				return response('<ajax-response><xmsg status="0"/></ajax-response>')
			}
		}
		return null
	})

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).setWlanPassword('Main', 'newpass-secret')

	const updateBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='updobj'"))
	expect(updateBody).toContain("passphrase='newpass-secret'")
	expect(updateBody).not.toContain("passphrase='oldpass'")
	expect(updateBody).toContain("name='Main'")
})

test('set wlan password preserves dollar signs and ampersands in the passphrase', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("action='getconf'")) {
				return response(
					[
						'<ajax-response><wlansvc-list>',
						"<wlansvc id='1' name='Main' ssid='Main' encryption='wpa2'>",
						"<wpa cipher='aes' passphrase='oldpass' dynamic-psk='disabled'/>",
						'</wlansvc>',
						'</wlansvc-list></ajax-response>',
					].join(''),
				)
			}
			if (body.includes("action='updobj'")) {
				return response('<ajax-response><xmsg status="0"/></ajax-response>')
			}
		}
		return null
	})

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).setWlanPassword('Main', 'Pa$$w0rd&$1$2')

	const updateBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='updobj'"))
	expect(updateBody).toContain("passphrase='Pa$$w0rd&amp;$1$2'")
	expect(updateBody).not.toContain("passphrase='oldpass'")
})

test('add wlan keeps dollar signs in the passphrase intact', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (
				body.includes("action='getconf'") &&
				body.includes("comp='wlansvc-standard-template'")
			) {
				return response(
					[
						'<ajax-response><wlansvc-standard-template>',
						"<wlansvc id='99' name='default-standard-wlan' ssid='' encryption='wpa2'>",
						"<wpa cipher='aes' passphrase='placeholder' dynamic-psk='disabled'/>",
						'</wlansvc></wlansvc-standard-template></ajax-response>',
					].join(''),
				)
			}
			if (body.includes("action='addobj'")) {
				return response('<ajax-response><xmsg status="0"/></ajax-response>')
			}
		}
		return null
	})

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).addWlan({
		ssid: 'NewNet',
		passphrase: 'A$$strong$1word',
	})

	const addBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='addobj'"))
	expect(addBody).toContain("passphrase='A$$strong$1word'")
})

test('add wlan posts an addobj request derived from the standard template', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (
				body.includes("action='getconf'") &&
				body.includes("comp='wlansvc-standard-template'")
			) {
				return response(
					[
						'<ajax-response><wlansvc-standard-template>',
						"<wlansvc id='99' name='default-standard-wlan' ssid='' encryption='none' authentication='open'/>",
						'</wlansvc-standard-template></ajax-response>',
					].join(''),
				)
			}
			if (body.includes("action='addobj'")) {
				return response('<ajax-response><xmsg status="0"/></ajax-response>')
			}
		}
		return null
	})

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).addWlan({
		ssid: 'NewNet',
		passphrase: 'super-secret',
	})

	const addBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='addobj'"))
	expect(addBody).toContain("name='NewNet'")
	expect(addBody).toContain("ssid='NewNet'")
	expect(addBody).toContain("passphrase='super-secret'")
	expect(addBody).not.toMatch(/\bid='99'/)
})

test('clone wlan duplicates source XML under a new name without the id', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("action='getconf'")) {
				return response(
					[
						'<ajax-response><wlansvc-list>',
						"<wlansvc id='1' name='Main' ssid='Main' encryption='wpa2'>",
						"<wpa cipher='aes' passphrase='secret' dynamic-psk='disabled'/>",
						'</wlansvc>',
						'</wlansvc-list></ajax-response>',
					].join(''),
				)
			}
			if (body.includes("action='addobj'")) {
				return response('<ajax-response><xmsg status="0"/></ajax-response>')
			}
		}
		return null
	})

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).cloneWlan('Main', 'Backup')

	const addBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='addobj'"))
	expect(addBody).toContain("name='Backup'")
	expect(addBody).toContain("ssid='Backup'")
	expect(addBody).toContain("passphrase='secret'")
	expect(addBody).not.toMatch(/\bid='1'/)
})

test('delete wlan posts a delobj request with the resolved id', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("action='getconf'")) {
				return response(
					[
						'<ajax-response><wlansvc-list>',
						"<wlansvc id='42' name='Guest' ssid='Guest'/>",
						'</wlansvc-list></ajax-response>',
					].join(''),
				)
			}
			if (body.includes("action='delobj'")) {
				return response('<ajax-response><xmsg status="0"/></ajax-response>')
			}
		}
		return null
	})

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).deleteWlan('Guest')

	const delBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='delobj'"))
	expect(delBody).toContain("id='42'")
	expect(delBody).toContain("comp='wlansvc-list'")
})

test('add wlan group posts addobj with named members resolved to ids', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("action='getconf'")) {
				return response(
					[
						'<ajax-response><wlansvc-list>',
						"<wlansvc id='1' name='Main' ssid='Main'/>",
						"<wlansvc id='2' name='Guest' ssid='Guest'/>",
						'</wlansvc-list></ajax-response>',
					].join(''),
				)
			}
			if (body.includes("action='addobj'")) {
				return response('<ajax-response><xmsg status="0"/></ajax-response>')
			}
		}
		return null
	})

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).addWlanGroup({
		name: 'House',
		description: 'home group',
		wlans: ['Main', 'Guest'],
	})

	const addBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='addobj'"))
	expect(addBody).toContain("comp='wlangroup-list'")
	expect(addBody).toContain("name='House'")
	expect(addBody).toContain("description='home group'")
	expect(addBody).toContain("<wlansvc id='1'/>")
	expect(addBody).toContain("<wlansvc id='2'/>")
})

test('delete wlan group posts delobj with the resolved id', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("action='getconf'")) {
				return response(
					[
						'<ajax-response><wlangroup-list>',
						"<wlangroup id='7' name='House' description='home'/>",
						'</wlangroup-list></ajax-response>',
					].join(''),
				)
			}
			if (body.includes("action='delobj'")) {
				return response('<ajax-response><xmsg status="0"/></ajax-response>')
			}
		}
		return null
	})

	await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).deleteWlanGroup('House')

	const delBody = fetchMock.mock.calls
		.map((call) => String(call[1]?.body ?? ''))
		.find((body) => body.includes("action='delobj'"))
	expect(delBody).toContain("id='7'")
	expect(delBody).toContain("comp='wlangroup-list'")
})

test('list active rogues issues a stamgr cmdstat request', async () => {
	const config = createConfig()
	const fetchMock = installFetch(loginHandler(), (href, init) => {
		if (href.endsWith('/_cmdstat.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes('<rogue') && body.includes("comp='stamgr'")) {
				return response(
					'<ajax-response><rogue mac="11:22:33:44:55:66" ssid="rogue-net"/></ajax-response>',
				)
			}
		}
		return null
	})
	const rogues = await createAccessNetworksUnleashedAjaxClient({
		config,
		controller: createController(),
	}).listActiveRogues()
	expect(rogues).toEqual([
		expect.objectContaining({ mac: '11:22:33:44:55:66' }),
	])
	expect(
		fetchMock.mock.calls.some((call) =>
			String(call[1]?.body ?? '').includes("recognized='!true'"),
		),
	).toBe(true)
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

	await expect(client.listClients()).rejects.toThrow('login was rejected')
	await expect(client.listClients()).resolves.toEqual([
		expect.objectContaining({
			mac: 'aa:bb:cc:dd:ee:ff',
		}),
	])
})
