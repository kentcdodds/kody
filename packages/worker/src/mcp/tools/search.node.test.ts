import { expect, test } from 'vitest'
import {
	loadDownHomeConnectorStatus,
	loadOptionalSearchRows,
	resolveSearchMemoryContext,
} from './search.ts'

test('search memory context falls back to the query when omitted', () => {
	expect(
		resolveSearchMemoryContext({
			query: 'saved interactive dashboard app',
		}),
	).toEqual({
		query: 'saved interactive dashboard app',
	})
})

test('search memory context preserves explicit caller context', () => {
	expect(
		resolveSearchMemoryContext({
			query: 'saved interactive dashboard app',
			memoryContext: {
				task: 'Find dashboard app',
				query: 'saved dashboard app',
				entities: ['dashboard'],
			},
		}),
	).toEqual({
		task: 'Find dashboard app',
		query: 'saved dashboard app',
		entities: ['dashboard'],
	})
})

test('search memory context does not synthesize a fallback for blank queries', () => {
	expect(
		resolveSearchMemoryContext({
			query: '   ',
		}),
	).toBeUndefined()
})

test('optional search rows fall back when saved skills lookup fails', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadSkills: async () => {
			throw new Error('D1 skills unavailable')
		},
		loadUiArtifacts: async () => [
			{
				id: 'app-123',
				user_id: 'user-123',
				title: 'Roku remote',
				description: 'Saved remote UI',
				code: '<div />',
				runtime: 'html',
				parameters: null,
				hidden: false,
				created_at: '2026-03-24T00:00:00.000Z',
				updated_at: '2026-03-24T00:00:00.000Z',
			},
		],
		loadUserSecrets: async () => [],
		loadUserValues: async () => [],
	})

	expect(result.skillRows).toEqual([])
	expect(result.uiArtifactRows).toHaveLength(1)
	expect(result.userSecretRows).toEqual([])
	expect(result.userValueRows).toEqual([])
	expect(result.warnings).toEqual([
		'Saved skills are temporarily unavailable: D1 skills unavailable',
	])
})

test('optional search rows fall back when saved apps lookup fails', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadSkills: async () => [],
		loadUiArtifacts: async () => {
			throw new Error('D1 apps unavailable')
		},
		loadUserSecrets: async () => [],
		loadUserValues: async () => [],
	})

	expect(result.skillRows).toEqual([])
	expect(result.uiArtifactRows).toEqual([])
	expect(result.userSecretRows).toEqual([])
	expect(result.userValueRows).toEqual([])
	expect(result.warnings).toEqual([
		'Saved apps are temporarily unavailable: D1 apps unavailable',
	])
})

test('optional search rows fall back when persisted values lookup fails', async () => {
	const result = await loadOptionalSearchRows({
		userId: 'user-123',
		loadSkills: async () => [],
		loadUiArtifacts: async () => [],
		loadUserSecrets: async () => [],
		loadUserValues: async () => {
			throw new Error('D1 values unavailable')
		},
	})

	expect(result.skillRows).toEqual([])
	expect(result.uiArtifactRows).toEqual([])
	expect(result.userSecretRows).toEqual([])
	expect(result.userValueRows).toEqual([])
	expect(result.warnings).toEqual([
		'Persisted values are temporarily unavailable: D1 values unavailable',
	])
})

test('optional search rows skip D1 access without a user', async () => {
	const result = await loadOptionalSearchRows({
		userId: null,
		loadSkills: async () => {
			throw new Error('should not run')
		},
		loadUiArtifacts: async () => {
			throw new Error('should not run')
		},
		loadUserSecrets: async () => {
			throw new Error('should not run')
		},
		loadUserValues: async () => {
			throw new Error('should not run')
		},
	})

	expect(result).toEqual({
		skillRows: [],
		uiArtifactRows: [],
		userSecretRows: [],
		userValueRows: [],
		warnings: [],
	})
})

test('down home connector status is returned when the connector is disconnected', async () => {
	const status = await loadDownHomeConnectorStatus({
		env: {
			HOME_CONNECTOR_SESSION: {
				idFromName(name: string) {
					return name
				},
				get() {
					return {
						fetch() {
							return Promise.resolve(Response.json(null))
						},
					}
				},
			},
		} as unknown as Env,
		homeConnectorId: 'default',
	})

	expect(status).toMatchObject({
		state: 'disconnected',
		connectorId: 'default',
		connected: false,
		toolCount: 0,
	})
})

test('down home connector status stays hidden when the connector is up', async () => {
	const status = await loadDownHomeConnectorStatus({
		env: {
			HOME_CONNECTOR_SESSION: {
				idFromName(name: string) {
					return name
				},
				get() {
					return {
						fetch() {
							return Promise.resolve(
								Response.json({
									connectorId: 'default',
									connectedAt: '2026-03-25T00:00:00.000Z',
									lastSeenAt: '2026-03-25T00:00:01.000Z',
									tools: [{ name: 'roku_press_key' }],
								}),
							)
						},
					}
				},
			},
		} as unknown as Env,
		homeConnectorId: 'default',
	})

	expect(status).toBeNull()
})
