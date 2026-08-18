import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'

test('meta_list_capabilities lists builtin capabilities and filters by domain', async () => {
	const allResult = await metaListCapabilitiesCapability.handler(
		{
			detail: true,
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'user-1@example.com',
					displayName: 'user-1',
				},
			}),
		},
	)

	expect(allResult.capabilities.length).toBeGreaterThan(0)
	expect(
		allResult.capabilities.some(
			(capability) => capability.name === 'meta_list_capabilities',
		),
	).toBe(true)

	const metaOnly = await metaListCapabilitiesCapability.handler(
		{
			domain: 'meta',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	expect(metaOnly.total).toBeGreaterThan(0)
	expect(
		metaOnly.capabilities.every((capability) => capability.domain === 'meta'),
	).toBe(true)
	expect(
		metaOnly.capabilities.some(
			(capability) => capability.name === 'meta_list_capabilities',
		),
	).toBe(true)

	const packagesOnly = await metaListCapabilitiesCapability.handler(
		{
			domain: 'packages',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	expect(packagesOnly.total).toBeGreaterThan(0)
	expect(
		packagesOnly.capabilities.every(
			(capability) => capability.domain === 'packages',
		),
	).toBe(true)

	const repoOnly = await metaListCapabilitiesCapability.handler(
		{
			domain: 'repo',
			detail: true,
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
			}),
		},
	)
	const listSessionsCapability = repoOnly.capabilities.find(
		(capability) => capability.name === 'repo_list_sessions',
	)
	expect(listSessionsCapability).toMatchObject({
		domain: 'repo',
		readOnly: true,
		idempotent: true,
		destructive: false,
		requiredInputFields: [],
		inputTypeDefinition: expect.stringContaining('status'),
		outputTypeDefinition: expect.stringContaining('sessions'),
	})
})
