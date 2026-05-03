import { expect, test, vi } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import { createAccessNetworksUnleashedAdapter } from './index.ts'

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

function createConfig() {
	using _env = createTemporaryEnv({
		MOCKS: 'false',
		HOME_CONNECTOR_ID: 'default',
		HOME_CONNECTOR_SHARED_SECRET: 'home-connector-secret-home-connector-secret',
		WORKER_BASE_URL: 'http://localhost:3742',
		ACCESS_NETWORKS_UNLEASHED_SCAN_CIDRS: '192.168.10.60/32',
		ACCESS_NETWORKS_UNLEASHED_ALLOW_INSECURE_TLS: 'true',
		HOME_CONNECTOR_DB_PATH: ':memory:',
	})
	return loadHomeConnectorConfig()
}

function response(
	body: string | null,
	init: ResponseInit & { url?: string } = {},
) {
	const output = new Response(body, init)
	Object.defineProperty(output, 'url', {
		value: init.url ?? 'https://192.168.10.60/admin/wsg',
	})
	return output
}

test('access networks unleashed adapter supports scan, adopt, credentials, and status workflow', async () => {
	const previousFetch = globalThis.fetch
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
	})
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		if (href === 'https://192.168.10.60/') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://192.168.10.60/',
			})
		}
		if (init?.method === 'HEAD' && href === 'https://192.168.10.60') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://192.168.10.60/',
			})
		}
		if (init?.method === 'HEAD' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://192.168.10.60/admin/wsg/login.jsp',
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
		if (href.endsWith('/_cmdstat.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("comp='system'")) {
				return response(
					'<ajax-response><system name="Access Networks Unleashed" version="200.15.6.212"/></ajax-response>',
				)
			}
			if (body.includes('<client LEVEL=')) {
				return response(
					'<ajax-response><client mac="aa:bb:cc:dd:ee:ff" hostname="phone" wlan="Main"/></ajax-response>',
				)
			}
			if (body.includes('<ap LEVEL=')) {
				return response(
					'<ajax-response><ap id="1" mac="24:79:de:ad:be:ef" name="Kitchen AP"/></ajax-response>',
				)
			}
			if (body.includes('<xevent />')) {
				return response(
					'<ajax-response><xevent message="client associated"/></ajax-response>',
				)
			}
		}
		if (href.endsWith('/_conf.jsp')) {
			const body = String(init?.body ?? '')
			if (body.includes("comp='wlansvc-list'")) {
				return response(
					'<ajax-response><wlansvc-list><wlansvc id="1" name="Main" ssid="Main"/></wlansvc-list></ajax-response>',
				)
			}
			return response('<ajax-response><xmsg status="0"/></ajax-response>')
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch

	try {
		expect(adapter.getConfigStatus()).toMatchObject({
			configured: false,
			missingRequirements: ['controller', 'credentials'],
		})

		const scanned = await adapter.scan()
		expect(scanned).toHaveLength(1)
		expect(scanned[0]).toMatchObject({
			controllerId: '192.168.10.60',
			adopted: false,
			hasStoredCredentials: false,
		})

		const adopted = adapter.adoptController({
			controllerId: '192.168.10.60',
		})
		expect(adopted).toMatchObject({
			controllerId: '192.168.10.60',
			adopted: true,
			hasStoredCredentials: false,
		})

		const stored = adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})
		expect(stored).toMatchObject({
			controllerId: '192.168.10.60',
			hasStoredCredentials: true,
		})

		const authenticated = await adapter.authenticate()
		expect(authenticated).toMatchObject({
			controllerId: '192.168.10.60',
			hasStoredCredentials: true,
			lastAuthenticatedAt: expect.any(String),
			lastAuthError: null,
		})

		const loginAttempts = fetchMock.mock.calls.filter(
			([url, init]) =>
				init?.method === 'HEAD' && String(url).includes('username=admin'),
		)
		expect(loginAttempts).toHaveLength(1)

		const status = await adapter.getStatus()
		expect(status).toMatchObject({
			config: {
				configured: true,
				adoptedControllerId: '192.168.10.60',
				hasStoredCredentials: true,
			},
			controller: {
				controllerId: '192.168.10.60',
				hasStoredCredentials: true,
			},
			system: {
				name: 'Access Networks Unleashed',
			},
			aps: [
				{
					name: 'Kitchen AP',
				},
			],
			wlans: [
				{
					name: 'Main',
				},
			],
			clients: [
				{
					hostname: 'phone',
				},
			],
			events: [
				{
					message: 'client associated',
				},
			],
		})
	} finally {
		globalThis.fetch = previousFetch
		storage.close()
	}
})
