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
	clearEnabledMcpServerRefsCacheForTests,
	enabledMcpServerRefsCacheTtlMs,
	listEnabledMcpServerRefsCached,
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

function setupEnabledServerFixture() {
	clearEnabledMcpServerRefsCacheForTests()
	mockModule.listEnabledMcpServerSettingRows.mockResolvedValue([
		createSettingRow({ id: 'server-1' }),
	])
}

test('listEnabledMcpServerRefsCached serves warm calls without a D1 read, per user', async () => {
	setupEnabledServerFixture()
	const env = { APP_DB: {} } as Env

	const first = await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })
	const second = await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })

	expect(first).toEqual([{ serverId: 'server-1', name: 'server-server-1' }])
	expect(second).toBe(first)
	expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(1)

	await listEnabledMcpServerRefsCached({ env, userId: 'user-2' })
	// Another user's lookup must not reuse user-1's entry.
	expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(2)
	expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenLastCalledWith(
		expect.objectContaining({ userId: 'user-2' }),
	)
})

test('listEnabledMcpServerRefsCached expires after its TTL', async () => {
	setupEnabledServerFixture()
	vi.useFakeTimers()
	try {
		const env = { APP_DB: {} } as Env
		await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })
		vi.setSystemTime(Date.now() + enabledMcpServerRefsCacheTtlMs + 1)
		await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })
		expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}
})

test('mutations invalidate the enabled-refs cache in the same isolate', async () => {
	setupEnabledServerFixture()
	const env = { APP_DB: {} } as Env
	const warm = await listEnabledMcpServerRefsCached({ env, userId: 'user-1' })
	expect(warm).toHaveLength(1)

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
	expect(mockModule.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(2)
})
