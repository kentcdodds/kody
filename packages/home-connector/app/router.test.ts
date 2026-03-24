import { expect, test } from 'bun:test'
import { createAppState } from '../src/state.ts'
import { createHomeConnectorRouter } from './router.ts'

test('home route renders admin dashboard links and connection info', async () => {
	const state = createAppState()
	state.connection.connectorId = 'default'
	state.connection.workerUrl = 'http://localhost:3742'
	state.connection.connected = true
	state.connection.sharedSecret = 'secret'
	const router = createHomeConnectorRouter(state)
	const response = await router.fetch('http://example.test/')
	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('Home connector admin')
	expect(html).toContain('/roku/status')
	expect(html).toContain('/roku/setup')
	expect(html).toContain('/home/connectors/default/snapshot')
	expect(html).toContain('connected')
})

test('health route returns ok json', async () => {
	const router = createHomeConnectorRouter(createAppState())
	const response = await router.fetch('http://example.test/health')
	expect(response.status).toBe(200)
	expect(await response.json()).toEqual({
		ok: true,
		service: 'home-connector',
		connectorId: '',
	})
})

test('roku status route renders connector details', async () => {
	const state = createAppState()
	state.connection.connectorId = 'default'
	state.connection.workerUrl = 'http://localhost:3742'
	state.connection.connected = true
	state.connection.lastSyncAt = '2026-03-24T12:00:00.000Z'
	const router = createHomeConnectorRouter(state)
	const response = await router.fetch('http://example.test/roku/status')
	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('Roku status')
	expect(html).toContain('connected')
	expect(html).toContain('default')
})

test('roku setup route reports missing shared secret clearly', async () => {
	const state = createAppState()
	state.connection.connectorId = 'default'
	state.connection.workerUrl = 'http://localhost:3742'
	state.connection.sharedSecret = null
	state.connection.mocksEnabled = true
	const router = createHomeConnectorRouter(state)
	const response = await router.fetch('http://example.test/roku/setup')
	expect(response.status).toBe(200)
	const html = await response.text()
	expect(html).toContain('Shared secret is missing.')
	expect(html).toContain('Mocks are enabled')
})
