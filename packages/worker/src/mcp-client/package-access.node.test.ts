import { expect, test } from 'vitest'
import {
	canCallerUseMcpServer,
	createMcpServerExecuteAccessDeniedMessage,
	createMcpServerPackageAccessDeniedMessage,
	filterEnabledMcpServerRefsForCaller,
	type EnabledMcpServerRef,
} from './package-access.ts'

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

	expect(
		createMcpServerExecuteAccessDeniedMessage({
			serverName: 'linear',
			usageUrl: 'https://kody.codes/account/mcp-servers/server-1',
		}),
	).toContain('cannot be used from execute')
	expect(
		createMcpServerPackageAccessDeniedMessage({
			serverName: 'linear',
			packageName: 'other',
			usageUrl: 'https://kody.codes/account/mcp-servers/server-1',
		}),
	).toContain('not approved to use MCP server "linear"')
})
