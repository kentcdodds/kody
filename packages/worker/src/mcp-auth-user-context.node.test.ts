import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mockModule = vi.hoisted(() => ({
	getUserRolesAndPermissions: vi.fn(),
}))

vi.mock('#worker/identity/permissions-db.ts', () => ({
	getUserRolesAndPermissions: (...args: Array<unknown>) =>
		mockModule.getUserRolesAndPermissions(...args),
}))

const {
	buildMcpUserContextFromGrantProps,
	listAttachedRemoteConnectorRefsCached,
} = await import('./mcp-auth-user-context.ts')

type GrantUserRow = {
	id: number
	email: string
	username: string | null
	display_name: string | null
	stable_user_id: string
	deleting_at?: string | null
	email_verified_at?: string | null
	suspended_at?: string | null
}

function createMockAppDb(options: {
	row?: GrantUserRow | null
	reject?: Error
	connectorRows?: Array<{ instance_id: string }>
	onConnectorQuery?: () => void
}) {
	const queries: Array<{ sql: string; params: Array<unknown> }> = []
	const db = {
		prepare(sql: string) {
			return {
				bind(...params: Array<unknown>) {
					queries.push({ sql, params })
					return {
						async first<T>() {
							if (options.reject) throw options.reject
							const normalized = sql.replace(/\s+/g, ' ').toLowerCase()
							if (
								normalized.includes('where stable_user_id = ?') &&
								normalized.includes('select id')
							) {
								return (options.row ?? null) as T | null
							}
							throw new Error(`Unsupported query: ${sql}`)
						},
						async all<T>() {
							options.onConnectorQuery?.()
							return {
								results: (options.connectorRows ?? []) as Array<T>,
								success: true,
								meta: {},
							}
						},
					}
				},
			}
		},
	} as unknown as D1Database
	return { db, queries }
}

test('buildMcpUserContextFromGrantProps resolves by stable id, refreshes profile, and fails closed', async () => {
	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['admin'],
		permissions: ['read:user:any', 'read:role:any'],
	})
	const refreshed = createMockAppDb({
		row: {
			id: 42,
			email: 'current@example.com',
			username: 'admin',
			display_name: 'Admin Display',
			stable_user_id: 'stable-admin-id',
		},
	})

	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: refreshed.db } as Env, {
			userId: 'stable-admin-id',
			email: 'stale@example.com',
			username: 'stale-username',
			displayName: 'stale display',
		}),
	).resolves.toEqual({
		user: {
			userId: 'stable-admin-id',
			email: 'current@example.com',
			username: 'admin',
			displayName: 'Admin Display',
			roles: ['admin'],
			permissions: ['read:user:any', 'read:role:any'],
		},
		emailVerified: false,
		suspended: false,
		remoteConnectors: [],
	})
	expect(refreshed.queries).toHaveLength(2)
	expect(refreshed.queries[0]?.params).toEqual(['stable-admin-id'])
	expect(refreshed.queries[0]?.sql).toContain('email_verified_at')
	expect(refreshed.queries[0]?.sql).toContain('suspended_at')
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledWith(
		refreshed.db,
		42,
	)

	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['user'],
		permissions: [],
	})
	const staleEmailOwnedElsewhere = createMockAppDb({
		row: {
			id: 7,
			email: 'original-owner@example.com',
			username: 'original',
			display_name: null,
			stable_user_id: 'stable-original',
		},
	})
	await expect(
		buildMcpUserContextFromGrantProps(
			{ APP_DB: staleEmailOwnedElsewhere.db } as Env,
			{
				userId: 'stable-original',
				// Email now belongs to a different verified admin account.
				email: 'reused-by-admin@example.com',
				displayName: 'stale',
			},
		),
	).resolves.toEqual({
		user: {
			userId: 'stable-original',
			email: 'original-owner@example.com',
			username: 'original',
			displayName: 'original',
			roles: ['user'],
			permissions: [],
		},
		emailVerified: false,
		suspended: false,
		remoteConnectors: [],
	})
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledWith(
		staleEmailOwnedElsewhere.db,
		7,
	)

	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['user'],
		permissions: [],
	})
	const emailOmitted = createMockAppDb({
		row: {
			id: 9,
			email: 'resolved@example.com',
			username: 'resolved',
			display_name: null,
			stable_user_id: 'legacy-id',
		},
	})
	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: emailOmitted.db } as Env, {
			userId: 'legacy-id',
		}),
	).resolves.toEqual({
		user: {
			userId: 'legacy-id',
			email: 'resolved@example.com',
			username: 'resolved',
			displayName: 'resolved',
			roles: ['user'],
			permissions: [],
		},
		emailVerified: false,
		suspended: false,
		remoteConnectors: [],
	})
	expect(emailOmitted.queries[0]?.params).toEqual(['legacy-id'])

	const missingRow = createMockAppDb({ row: null })
	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: missingRow.db } as Env, {
			userId: 'orphan-id',
			email: 'missing@example.com',
			displayName: 'missing',
		}),
	).resolves.toBeNull()
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledTimes(3)

	const deleting = createMockAppDb({
		row: {
			id: 10,
			email: 'deleting@example.com',
			username: 'deleting',
			display_name: null,
			stable_user_id: 'deleting-id',
			deleting_at: '2026-07-22 22:00:00',
		},
	})
	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: deleting.db } as Env, {
			userId: 'deleting-id',
			email: 'deleting@example.com',
		}),
	).resolves.toBeNull()

	consoleError.mockImplementation(() => {})
	const failingDb = createMockAppDb({
		reject: new Error('D1 unavailable'),
	})
	await expect(
		buildMcpUserContextFromGrantProps({ APP_DB: failingDb.db } as Env, {
			userId: 'resilient-id',
			email: 'resilient@example.com',
			displayName: 'resilient',
		}),
	).rejects.toThrow('D1 unavailable')
	expect(consoleError).toHaveBeenCalled()
	expect(mockModule.getUserRolesAndPermissions).toHaveBeenCalledTimes(3)
})

test('MCP auth reads account gates once, loads roles and connectors in parallel, and caches connector refs', async () => {
	let resolveRoles: (value: {
		roles: Array<string>
		permissions: Array<string>
	}) => void = () => undefined
	const roles = new Promise<{
		roles: Array<string>
		permissions: Array<string>
	}>((resolve) => {
		resolveRoles = resolve
	})
	let rolesStarted = false
	let connectorStarted = false
	mockModule.getUserRolesAndPermissions.mockImplementationOnce(() => {
		rolesStarted = true
		return roles
	})
	const account = createMockAppDb({
		row: {
			id: 12,
			email: 'verified@example.com',
			username: 'verified',
			display_name: null,
			stable_user_id: 'verified-id',
			email_verified_at: '2026-07-31 04:00:00',
			suspended_at: null,
		},
		connectorRows: [{ instance_id: 'home' }],
		onConnectorQuery() {
			connectorStarted = true
		},
	})

	const pending = buildMcpUserContextFromGrantProps(
		{ APP_DB: account.db } as Env,
		{ userId: 'verified-id' },
	)
	await vi.waitFor(() => {
		expect(rolesStarted).toBe(true)
		expect(connectorStarted).toBe(true)
	})
	resolveRoles({ roles: ['user'], permissions: [] })
	await expect(pending).resolves.toMatchObject({
		emailVerified: true,
		suspended: false,
		remoteConnectors: [{ instanceId: 'home' }],
	})

	mockModule.getUserRolesAndPermissions.mockResolvedValueOnce({
		roles: ['user'],
		permissions: [],
	})
	await buildMcpUserContextFromGrantProps({ APP_DB: account.db } as Env, {
		userId: 'verified-id',
	})
	await expect(
		listAttachedRemoteConnectorRefsCached({
			env: { APP_DB: account.db } as Env,
			userId: 'verified-id',
		}),
	).resolves.toEqual([{ instanceId: 'home' }])
	expect(
		account.queries.filter(({ sql }) =>
			sql.toLowerCase().includes('remote_connector_settings'),
		),
	).toHaveLength(1)
	expect(
		account.queries.filter(({ sql }) =>
			sql.toLowerCase().includes('from users'),
		),
	).toHaveLength(2)
})
