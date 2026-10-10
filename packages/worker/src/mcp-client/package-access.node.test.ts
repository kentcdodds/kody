import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	assertCanUseMcpServer,
	canCallerUseMcpServer,
	filterEnabledMcpServerRefsForCaller,
	McpServerPackageAccessDeniedError,
	type EnabledMcpServerRef,
} from './package-access.ts'
import type * as SettingsRepo from './settings-repo.ts'

const mocks = vi.hoisted(() => ({
	getMcpServerSettingRowById: vi.fn(),
}))

vi.mock('./settings-repo.ts', async () => {
	const actual =
		await vi.importActual<typeof SettingsRepo>('./settings-repo.ts')
	return {
		...actual,
		getMcpServerSettingRowById: (...args: Array<unknown>) =>
			mocks.getMcpServerSettingRowById(...args),
	}
})

function ref(
	overrides: Partial<EnabledMcpServerRef> = {},
): EnabledMcpServerRef {
	return {
		serverId: 'server-1',
		name: 'linear',
		usageMode: 'any',
		allowedPackageIds: [],
		...overrides,
	}
}

test('package-locked MCP servers are hidden from execute and other packages', () => {
	expect(
		canCallerUseMcpServer({
			usageMode: 'any',
			allowedPackageIds: [],
			packageId: null,
		}),
	).toBe(true)
	expect(
		canCallerUseMcpServer({
			usageMode: 'packages',
			allowedPackageIds: ['pkg-drafts'],
			packageId: null,
		}),
	).toBe(false)
	expect(
		canCallerUseMcpServer({
			usageMode: 'packages',
			allowedPackageIds: ['pkg-drafts'],
			packageId: 'pkg-drafts',
		}),
	).toBe(true)
	expect(
		canCallerUseMcpServer({
			usageMode: 'packages',
			allowedPackageIds: ['pkg-drafts'],
			packageId: 'pkg-other',
		}),
	).toBe(false)

	const refs = [
		ref(),
		ref({
			serverId: 'server-2',
			name: 'notion',
			usageMode: 'packages',
			allowedPackageIds: ['pkg-notes'],
		}),
	]
	expect(
		filterEnabledMcpServerRefsForCaller({ refs, packageId: null }),
	).toEqual([{ serverId: 'server-1', name: 'linear' }])
	expect(
		filterEnabledMcpServerRefsForCaller({ refs, packageId: 'pkg-notes' }),
	).toEqual([
		{ serverId: 'server-1', name: 'linear' },
		{ serverId: 'server-2', name: 'notion' },
	])
})

test('assertCanUseMcpServer denies execute with the account usage URL message', async () => {
	mocks.getMcpServerSettingRowById.mockResolvedValue({
		id: 'server-notion',
		usage_mode: 'packages',
		allowedPackageIds: ['pkg-notion-read'],
	})
	const denied = await assertCanUseMcpServer({
		env: { APP_DB: {} } as Pick<Env, 'APP_DB'>,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('user-1'),
		serverId: 'server-notion',
		serverName: 'notion',
		packageId: null,
		orgSlug: 'ada',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(denied).toBeInstanceOf(McpServerPackageAccessDeniedError)
	expect((denied as Error).message).toContain(
		'https://example.com/@ada/-/mcp-servers/server-notion',
	)
	expect((denied as Error).message).toMatch(/cannot be used from execute/)

	await expect(
		assertCanUseMcpServer({
			env: { APP_DB: {} } as Pick<Env, 'APP_DB'>,
			baseUrl: 'https://example.com',
			userId: ownerIdFromStored('user-1'),
			serverId: 'server-notion',
			serverName: 'notion',
			packageId: 'pkg-notion-read',
		}),
	).resolves.toBeUndefined()
})
