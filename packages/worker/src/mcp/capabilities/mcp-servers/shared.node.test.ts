import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type McpServerSettingMetadata } from '#worker/mcp-client/settings-types.ts'

const mockModule = vi.hoisted(() => ({
	getMcpServerSettingById: vi.fn(),
	listMcpServerSettings: vi.fn(),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	getMcpServerSettingById: (...args: Array<unknown>) =>
		mockModule.getMcpServerSettingById(...args),
	listMcpServerSettings: (...args: Array<unknown>) =>
		mockModule.listMcpServerSettings(...args),
}))

const { resolveMcpServerSetting } = await import('./shared.ts')

function setting(
	overrides: Partial<McpServerSettingMetadata> = {},
): McpServerSettingMetadata {
	return {
		id: 'server-1',
		name: 'ha',
		url: 'https://example.com/mcp',
		enabled: true,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

test('resolveMcpServerSetting throws McpCallerError for unknown server names', async () => {
	mockModule.getMcpServerSettingById.mockReset()
	mockModule.listMcpServerSettings.mockReset()
	mockModule.getMcpServerSettingById.mockResolvedValue(null)
	mockModule.listMcpServerSettings.mockResolvedValue([setting()])

	const missing = resolveMcpServerSetting({
		env: { APP_DB: {} as D1Database },
		userId: 'user-1',
		server: 'recipe-keeper',
	})

	await expect(missing).rejects.toThrow(McpCallerError)
	await expect(missing).rejects.toThrow(
		'No MCP server matches "recipe-keeper". Saved servers: ha.',
	)
})

test('resolveMcpServerSetting throws McpCallerError for blank server identifiers', async () => {
	mockModule.getMcpServerSettingById.mockReset()
	mockModule.listMcpServerSettings.mockReset()

	const blank = resolveMcpServerSetting({
		env: { APP_DB: {} as D1Database },
		userId: 'user-1',
		server: '   ',
	})

	await expect(blank).rejects.toThrow(McpCallerError)
	await expect(blank).rejects.toThrow(
		'Provide the MCP server id or name in "server".',
	)
	expect(mockModule.getMcpServerSettingById).not.toHaveBeenCalled()
	expect(mockModule.listMcpServerSettings).not.toHaveBeenCalled()
})

test('resolveMcpServerSetting resolves by id or normalized name', async () => {
	mockModule.getMcpServerSettingById.mockReset()
	mockModule.listMcpServerSettings.mockReset()

	const byId = setting({ id: 'server-by-id', name: 'ha' })
	mockModule.getMcpServerSettingById.mockResolvedValueOnce(byId)
	await expect(
		resolveMcpServerSetting({
			env: { APP_DB: {} as D1Database },
			userId: 'user-1',
			server: 'server-by-id',
		}),
	).resolves.toEqual(byId)

	mockModule.getMcpServerSettingById.mockResolvedValueOnce(null)
	mockModule.listMcpServerSettings.mockResolvedValueOnce([
		setting({ id: 'server-by-name', name: 'ha' }),
	])
	await expect(
		resolveMcpServerSetting({
			env: { APP_DB: {} as D1Database },
			userId: 'user-1',
			server: 'HA',
		}),
	).resolves.toMatchObject({ id: 'server-by-name', name: 'ha' })
})
