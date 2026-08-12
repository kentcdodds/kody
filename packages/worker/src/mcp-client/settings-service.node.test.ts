import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	listEnabledMcpServerSettingRows: vi.fn(),
	getMcpServerSettingRowById: vi.fn(),
	getMcpServerSettingRowByName: vi.fn(),
	insertMcpServerSettingRow: vi.fn(),
	updateMcpServerSettingRow: vi.fn(),
	deleteMcpServerSettingRow: vi.fn(),
	listMcpServerSettingRows: vi.fn(),
	hubClient: {
		addServer: vi.fn(),
		removeServer: vi.fn(),
	},
}))

vi.mock('./settings-repo.ts', () => ({
	listEnabledMcpServerSettingRows: (...args: Array<unknown>) =>
		mockModule.listEnabledMcpServerSettingRows(...args),
	getMcpServerSettingRowById: (...args: Array<unknown>) =>
		mockModule.getMcpServerSettingRowById(...args),
	getMcpServerSettingRowByName: (...args: Array<unknown>) =>
		mockModule.getMcpServerSettingRowByName(...args),
	insertMcpServerSettingRow: (...args: Array<unknown>) =>
		mockModule.insertMcpServerSettingRow(...args),
	updateMcpServerSettingRow: (...args: Array<unknown>) =>
		mockModule.updateMcpServerSettingRow(...args),
	deleteMcpServerSettingRow: (...args: Array<unknown>) =>
		mockModule.deleteMcpServerSettingRow(...args),
	listMcpServerSettingRows: (...args: Array<unknown>) =>
		mockModule.listMcpServerSettingRows(...args),
}))

vi.mock('./hub-client.ts', () => ({
	createMcpClientHubClient: () => mockModule.hubClient,
}))

const {
	addMcpServer,
	clearEnabledMcpServerRefsCacheForTests,
	enabledMcpServerRefsCacheTtlMs,
	listEnabledMcpServerRefsCached,
	resolveMcpServerOAuthClientUrls,
	setMcpServerEnabled,
} = await import('./settings-service.ts')

function createSettingRow(input: { id: string; enabled?: boolean }) {
	return {
		id: input.id,
		user_id: 'user-1',
		name: `server-${input.id}`,
		url: `https://mcp.example.com/${input.id}`,
		enabled: input.enabled ?? true,
		created_at: '2026-07-01T00:00:00.000Z',
		updated_at: '2026-07-01T00:00:00.000Z',
	}
}

test('listEnabledMcpServerRefsCached warms per user, expires, and invalidates on mutation', async () => {
	clearEnabledMcpServerRefsCacheForTests()
	mockModule.listEnabledMcpServerSettingRows.mockResolvedValue([
		createSettingRow({ id: 'server-1' }),
	])

	const env = { APP_DB: {} } as Env
	const first = await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })
	const second = await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })
	expect(first).toEqual([{ serverId: 'server-1', name: 'server-server-1' }])
	expect(second).toBe(first)
	expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(1)

	await listEnabledMcpServerRefsCached({ env, userId: 'user-2' })
	expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(2)
	expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenLastCalledWith(
		expect.objectContaining({ userId: 'user-2' }),
	)

	vi.useFakeTimers()
	try {
		vi.setSystemTime(Date.now() + enabledMcpServerRefsCacheTtlMs + 1)
		await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })
		expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(3)
	} finally {
		vi.useRealTimers()
	}

	mockModule.getMcpServerSettingRowById.mockResolvedValue(
		createSettingRow({ id: 'server-1' }),
	)
	mockModule.updateMcpServerSettingRow.mockResolvedValue(true)
	await setMcpServerEnabled({
		env,
		userId: 'user-1',
		id: 'server-1',
		enabled: false,
	})
	mockModule.listEnabledMcpServerSettingRows.mockResolvedValue([])
	const afterDisable = await listEnabledMcpServerRefsCached({
		env,
		userId: 'user-1',
	})
	expect(afterDisable).toEqual([])
	expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(4)
})

test('resolveMcpServerOAuthClientUrls prefers APP_BASE_URL over the request host', () => {
	expect(
		resolveMcpServerOAuthClientUrls({
			env: { APP_BASE_URL: 'https://heykody.app/' },
			requestUrl: 'https://heykody.dev/account/mcp-servers',
		}),
	).toEqual({
		clientOrigin: 'https://heykody.app',
		callbackUrl: 'https://heykody.app/account/mcp-servers/oauth/callback',
	})

	expect(
		resolveMcpServerOAuthClientUrls({
			env: {},
			requestUrl: 'https://preview.example/account/mcp-servers',
		}),
	).toEqual({
		clientOrigin: 'https://preview.example',
		callbackUrl: 'https://preview.example/account/mcp-servers/oauth/callback',
	})
})

test('addMcpServer forwards bearer tokens as Authorization headers to the hub', async () => {
	clearEnabledMcpServerRefsCacheForTests()
	mockModule.getMcpServerSettingRowByName.mockResolvedValue(null)
	mockModule.insertMcpServerSettingRow.mockResolvedValue(undefined)
	mockModule.hubClient.addServer.mockResolvedValue({
		serverId: 'ignored',
		state: 'ready',
		authUrl: null,
		error: null,
		toolCount: 1,
	})

	const env = { APP_DB: {} } as Env
	const result = await addMcpServer({
		env,
		userId: 'user-1',
		name: 'linear',
		url: 'https://mcp.example.com/mcp',
		baseUrl: 'https://heykody.app',
		bearerToken: 'secret-token',
	})

	expect(result.setting.name).toBe('linear')
	expect(mockModule.hubClient.addServer).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'linear',
			url: 'https://mcp.example.com/mcp',
			callbackUrl: 'https://heykody.app/account/mcp-servers/oauth/callback',
			headers: { Authorization: 'Bearer secret-token' },
		}),
	)
	expect(mockModule.insertMcpServerSettingRow).toHaveBeenCalledWith(
		expect.objectContaining({
			row: expect.objectContaining({
				name: 'linear',
				url: 'https://mcp.example.com/mcp',
				user_id: 'user-1',
			}),
		}),
	)
	// D1 metadata must not carry the credential.
	const insertedRow = mockModule.insertMcpServerSettingRow.mock.calls[0]?.[0]
		?.row as Record<string, unknown>
	expect(insertedRow).not.toHaveProperty('bearerToken')
	expect(JSON.stringify(insertedRow)).not.toContain('secret-token')
})
