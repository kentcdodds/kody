import { expect, test, vi } from 'vitest'
import { loadHomeConnectorConfig } from '../../config.ts'
import { createAppState } from '../../state.ts'
import { createHomeConnectorStorage } from '../../storage/index.ts'
import {
	accessNetworksUnleashedRequestConfirmation,
	createAccessNetworksUnleashedAdapter,
} from './index.ts'

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

const validReason =
	'Operator needs raw AJAX access to verify a configuration change is correct.'

function installLoginAndCmdstat(handler: (body: string) => Response) {
	const previousFetch = globalThis.fetch
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const href = String(url)
		if (href === 'https://192.168.10.60/' || href === 'https://192.168.10.60') {
			return response(null, {
				status: 302,
				headers: { Location: '/admin/wsg/login.jsp' },
				url: 'https://192.168.10.60/',
			})
		}
		if (init?.method === 'GET' && href.endsWith('/admin/wsg/login.jsp')) {
			return response(null, {
				status: 200,
				url: 'https://192.168.10.60/admin/wsg/login.jsp',
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
		if (href.endsWith('/_cmdstat.jsp')) {
			return handler(String(init?.body ?? ''))
		}
		throw new Error(`Unexpected fetch ${href}`)
	})
	globalThis.fetch = fetchMock as typeof fetch
	return {
		fetchMock,
		[Symbol.dispose]: () => {
			globalThis.fetch = previousFetch
		},
	}
}

test('adapter exposes scan, adopt, set-credentials, authenticate, and request workflow', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
	})
	using _server = installLoginAndCmdstat(() =>
		response(
			'<ajax-response><system name="Access Networks Unleashed" version="200.15.6.212"/></ajax-response>',
		),
	)

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
		})

		adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		const authenticated = await adapter.authenticate()
		expect(authenticated.lastAuthenticatedAt).toEqual(expect.any(String))
		expect(authenticated.lastAuthError).toBeNull()

		const result = await adapter.request({
			action: 'getstat',
			comp: 'system',
			xmlBody: '<sysinfo/>',
			acknowledgeHighRisk: true,
			reason: validReason,
			confirmation: accessNetworksUnleashedRequestConfirmation,
		})
		expect(result.action).toBe('getstat')
		expect(result.parsed).toMatchObject({
			'ajax-response': {
				system: { '@name': 'Access Networks Unleashed' },
			},
		})

		const adoptedController = adapter.getAdoptedController()
		expect(adoptedController?.lastAuthenticatedAt).toEqual(expect.any(String))
		expect(adoptedController?.lastAuthError).toBeNull()
	} finally {
		storage.close()
	}
})

test('request rejects without acknowledgement, confirmation, or sufficient reason', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
		clientFactory: () => ({
			async request() {
				throw new Error('client should not be invoked when validation fails')
			},
		}),
	})
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)

	try {
		await adapter.scan()
		adapter.adoptController({ controllerId: '192.168.10.60' })
		adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: false,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('acknowledgeHighRisk')

		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: 'too short',
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('at least 20 characters')

		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: 'something else',
			}),
		).rejects.toThrow('confirmation must exactly equal')
	} finally {
		storage.close()
	}
})

test('request rejects unknown actions and empty comp', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
		clientFactory: () => ({
			async request() {
				throw new Error('client should not be invoked when validation fails')
			},
		}),
	})
	using _server = installLoginAndCmdstat(() =>
		response('<ajax-response><ok/></ajax-response>'),
	)

	try {
		await adapter.scan()
		adapter.adoptController({ controllerId: '192.168.10.60' })
		adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		await expect(
			adapter.request({
				// @ts-expect-error: invalid action by design
				action: 'delete',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('action must be one of')

		await expect(
			adapter.request({
				action: 'getstat',
				comp: '   ',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('comp must not be empty')
	} finally {
		storage.close()
	}
})

test('request requires an adopted controller with stored credentials', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
	})

	try {
		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('No Access Networks Unleashed controller is adopted')
	} finally {
		storage.close()
	}
})

test('request preserves last successful authentication on transient failure', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
	})
	let shouldFail = false
	using _server = installLoginAndCmdstat(() => {
		if (shouldFail) {
			throw new Error('temporary network outage')
		}
		return response(
			'<ajax-response><system name="Access Networks Unleashed"/></ajax-response>',
		)
	})

	try {
		await adapter.scan()
		adapter.adoptController({ controllerId: '192.168.10.60' })
		adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		const authenticated = await adapter.authenticate()
		const lastAuthenticatedAt = authenticated.lastAuthenticatedAt

		shouldFail = true
		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('temporary network outage')

		// A non-auth transport error must not be recorded as an authentication
		// failure; the previous successful auth state is kept intact so the next
		// retry does not look like the controller has bad credentials.
		const adopted = adapter.getAdoptedController()
		expect(adopted?.lastAuthenticatedAt).toBe(lastAuthenticatedAt)
		expect(adopted?.lastAuthError).toBeNull()
	} finally {
		storage.close()
	}
})

test('request records lastAuthError when the underlying call is an auth failure', async () => {
	const config = createConfig()
	const state = createAppState()
	const storage = createHomeConnectorStorage(config)
	const adapter = createAccessNetworksUnleashedAdapter({
		config,
		state,
		storage,
		clientFactory: () => ({
			async request() {
				throw new Error('Access Networks Unleashed login was rejected.')
			},
		}),
	})
	using _server = installLoginAndCmdstat(() =>
		response(
			'<ajax-response><system name="Access Networks Unleashed"/></ajax-response>',
		),
	)

	try {
		await adapter.scan()
		adapter.adoptController({ controllerId: '192.168.10.60' })
		adapter.setCredentials({
			controllerId: '192.168.10.60',
			username: 'admin',
			password: 'secret-password',
		})

		await expect(
			adapter.request({
				action: 'getstat',
				comp: 'system',
				xmlBody: '<sysinfo/>',
				acknowledgeHighRisk: true,
				reason: validReason,
				confirmation: accessNetworksUnleashedRequestConfirmation,
			}),
		).rejects.toThrow('login was rejected')

		const adopted = adapter.getAdoptedController()
		expect(adopted?.lastAuthError).toMatch(/login was rejected/)
	} finally {
		storage.close()
	}
})
