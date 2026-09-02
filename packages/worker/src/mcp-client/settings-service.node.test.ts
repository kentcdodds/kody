import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	listEnabledMcpServerSettingRows: vi.fn(),
	getMcpServerSettingRowById: vi.fn(),
	getMcpServerSettingRowByName: vi.fn(),
	insertMcpServerSettingRow: vi.fn(),
	updateMcpServerSettingRow: vi.fn(),
	deleteMcpServerSettingRow: vi.fn(),
	listMcpServerSettingRows: vi.fn(),
	updateMcpServerSettingUsageRow: vi.fn(),
	getSavedPackageById: vi.fn(),
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
	updateMcpServerSettingUsageRow: (...args: Array<unknown>) =>
		mockModule.updateMcpServerSettingUsageRow(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
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
	listVisibleEnabledMcpServerRefsCached,
	lockMcpServerToPackage,
	setMcpServerEnabled,
	setMcpServerUsage,
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
		logo_key: null,
		logo_content_type: null,
		logo_source: null,
		favicon_source_host: null,
		usage_mode: 'any' as const,
		allowedPackageIds: [],
	}
}

test('listEnabledMcpServerRefsCached warms per user, expires, and invalidates on mutation', async () => {
	clearEnabledMcpServerRefsCacheForTests()
	mockModule.listEnabledMcpServerSettingRows.mockResolvedValue([
		createSettingRow({ id: 'server-1' }),
	])

	const env = { APP_DB: {} } as Env
	const first = await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })
	const second = await listEnabledMcpServerRefsCached({
		env,
		userId: 'user-1',
	})
	expect(first).toEqual([
		{
			serverId: 'server-1',
			name: 'server-server-1',
			usageMode: 'any',
			allowedPackageIds: [],
		},
	])
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
		clientMetadataUrl: 'https://heykody.app/oauth/client-metadata.json',
	})

	expect(
		resolveMcpServerOAuthClientUrls({
			env: {},
			requestUrl: 'https://preview.example/account/mcp-servers',
		}),
	).toEqual({
		clientOrigin: 'https://preview.example',
		callbackUrl: 'https://preview.example/account/mcp-servers/oauth/callback',
		clientMetadataUrl: 'https://preview.example/oauth/client-metadata.json',
	})

	expect(
		resolveMcpServerOAuthClientUrls({
			env: {},
			requestUrl: 'http://localhost:8787/account/mcp-servers',
		}),
	).toEqual({
		clientOrigin: 'http://localhost:8787',
		callbackUrl: 'http://localhost:8787/account/mcp-servers/oauth/callback',
		clientMetadataUrl: null,
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

	mockModule.getMcpServerSettingRowByName.mockResolvedValue(null)
	mockModule.hubClient.addServer.mockRejectedValueOnce(
		new Error('invalid_redirect_uri'),
	)
	const allowlistFailure = addMcpServer({
		env,
		userId: 'user-1',
		name: 'vercel',
		url: 'https://mcp.vercel.com',
		baseUrl: 'https://kody.codes',
	})
	await expect(allowlistFailure).rejects.toThrow(/unapproved OAuth client/)
	await expect(allowlistFailure).rejects.toThrow(
		'https://kody.codes/account/mcp-servers/oauth/callback',
	)
	await expect(allowlistFailure).rejects.toThrow(
		'https://vercel.com/docs/agent-resources/vercel-mcp',
	)
	await expect(allowlistFailure).rejects.toThrow(
		'https://github.com/kentcdodds/kody/issues/1986',
	)
})

test('MCP server usage lock hides the server from execute and grants a package', async () => {
	clearEnabledMcpServerRefsCacheForTests()
	const env = { APP_DB: {} } as Env
	const lockedRow = {
		...createSettingRow({ id: 'server-1' }),
		usage_mode: 'packages' as const,
		allowedPackageIds: ['pkg-drafts'],
	}
	mockModule.getMcpServerSettingRowById.mockResolvedValue(
		createSettingRow({ id: 'server-1' }),
	)
	mockModule.updateMcpServerSettingUsageRow.mockResolvedValue(true)
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'pkg-drafts',
		kodyId: 'gmail-drafts',
	})

	const locked = await lockMcpServerToPackage({
		env,
		userId: 'user-1',
		id: 'server-1',
		packageId: 'pkg-drafts',
	})
	expect(locked.usageMode).toBe('packages')
	expect(locked.allowedPackageIds).toEqual(['pkg-drafts'])
	expect(mockModule.updateMcpServerSettingUsageRow).toHaveBeenCalledWith(
		expect.objectContaining({
			id: 'server-1',
			usageMode: 'packages',
			allowedPackageIds: ['pkg-drafts'],
		}),
	)

	mockModule.getMcpServerSettingRowById.mockResolvedValue(lockedRow)
	const unlocked = await setMcpServerUsage({
		env,
		userId: 'user-1',
		id: 'server-1',
		usageMode: 'any',
	})
	expect(unlocked.usageMode).toBe('any')
	expect(unlocked.allowedPackageIds).toEqual([])

	mockModule.listEnabledMcpServerSettingRows.mockResolvedValue([lockedRow])
	const executeRefs = await listVisibleEnabledMcpServerRefsCached({
		env,
		userId: 'user-1',
	})
	expect(executeRefs).toEqual([])
	const packageRefs = await listVisibleEnabledMcpServerRefsCached({
		env,
		userId: 'user-1',
		packageId: 'pkg-drafts',
	})
	expect(packageRefs).toEqual([
		{ serverId: 'server-1', name: 'server-server-1' },
	])
	const otherPackageRefs = await listVisibleEnabledMcpServerRefsCached({
		env,
		userId: 'user-1',
		packageId: 'pkg-other',
	})
	expect(otherPackageRefs).toEqual([])
})
