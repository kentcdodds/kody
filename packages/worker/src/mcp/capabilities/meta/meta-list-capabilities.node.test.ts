import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { mcpServerCapabilityId } from '#worker/mcp-client/mcp-domain-id.ts'
import * as hubClient from '#worker/mcp-client/hub-client.ts'
import * as settingsService from '#worker/mcp-client/settings-service.ts'
import { metaListCapabilitiesCapability } from './meta-list-capabilities.ts'

const personId = personIdFromStored('b'.repeat(64))
const teamOrgId = ownerIdFromStored('c'.repeat(64))
const teamServerId = 'mcp-server-team-1'
const teamServerName = 'exa'
const teamToolName = 'web_search'

afterEach(() => {
	vi.restoreAllMocks()
})

test('metaListCapabilities indexes domains and lists one requested domain', async () => {
	const allResult = await metaListCapabilitiesCapability.handler(
		{
			detail: true,
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
				user: {
					userId: personIdFromStored('user-1'),
					email: 'user-1@example.com',
					displayName: 'user-1',
				},
			}),
		},
	)

	expect(allResult.capabilities).toBeUndefined()
	expect(allResult.domains?.length).toBeGreaterThan(0)
	expect(allResult.domains).toContainEqual(
		expect.objectContaining({
			id: 'meta',
			capabilityCount: expect.any(Number),
			sampleCapabilities: expect.any(Array),
		}),
	)

	const metaOnly = await metaListCapabilitiesCapability.handler(
		{
			domain: 'meta',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	expect(metaOnly.total).toBeGreaterThan(0)
	expect(
		metaOnly.capabilities?.every((capability) => capability.domain === 'meta'),
	).toBe(true)
	expect(
		metaOnly.capabilities?.some(
			(capability) => capability.name === 'metaListCapabilities',
		),
	).toBe(true)
	expect(
		metaOnly.capabilities?.some(
			(capability) => capability.name === 'metaPlatformFeedbackGet',
		),
	).toBe(true)
	expect(
		metaOnly.capabilities?.some(
			(capability) => capability.name === 'metaPlatformFeedbackList',
		),
	).toBe(true)
	expect(
		metaOnly.capabilities?.some(
			(capability) => capability.name === 'metaPlatformFeedbackSubmit',
		),
	).toBe(true)

	const packagesOnly = await metaListCapabilitiesCapability.handler(
		{
			domain: 'packages',
		},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
			}),
		},
	)

	expect(packagesOnly.total).toBeGreaterThan(0)
	expect(
		packagesOnly.capabilities?.every(
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
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://heykody.dev',
			}),
		},
	)
	const listSessionsCapability = repoOnly.capabilities?.find(
		(capability) => capability.name === 'repoListSessions',
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

test('metaListCapabilities keeps team MCP tools when visibility uses the bound org', async () => {
	const env = {} as Env
	const visibilityOwnerIds: Array<string> = []
	vi.spyOn(
		settingsService,
		'listEnabledMcpServerRefsCached',
	).mockImplementation(async (input) => {
		if (input.userId !== teamOrgId) return []
		return [
			{
				serverId: teamServerId,
				name: teamServerName,
				usageMode: 'any',
				allowedPackageIds: [],
			},
		]
	})
	vi.spyOn(
		settingsService,
		'listVisibleEnabledMcpServerRefsCached',
	).mockImplementation(async (input) => {
		visibilityOwnerIds.push(input.userId)
		if (input.userId !== teamOrgId) return []
		return [
			{
				serverId: teamServerId,
				name: teamServerName,
				usageMode: 'any',
				allowedPackageIds: [],
			},
		]
	})
	vi.spyOn(hubClient, 'getCachedMcpClientHubSnapshot').mockImplementation(
		async (input) => {
			if (input.userId !== teamOrgId) {
				return { servers: [] }
			}
			return {
				servers: [
					{
						serverId: teamServerId,
						name: teamServerName,
						url: 'https://mcp.exa.ai/mcp',
						state: 'ready' as const,
						tools: [
							{
								name: teamToolName,
								description: 'Search the web',
								inputSchema: { type: 'object', properties: {} },
							},
						],
						error: null,
						lastError: null,
						instructions: null,
						hasRefreshToken: true,
						authorizationPending: false,
					},
				],
			}
		},
	)

	const capabilityName = mcpServerCapabilityId({
		ref: { name: teamServerName },
		toolName: teamToolName,
	})
	const result = await metaListCapabilitiesCapability.handler(
		{ domain: `mcp:${teamServerName}` },
		{
			env,
			callerContext: createMcpCallerContext({
				source: { kind: 'mcp-oauth' },
				baseUrl: 'https://kody.example',
				user: {
					userId: personId,
					email: 'brad@example.com',
					displayName: 'brad',
					roles: ['user'],
				},
				orgBinding: {
					org: { id: teamOrgId, slug: 'haveman' },
					role: 'owner',
				},
			}),
		},
	)

	expect(visibilityOwnerIds).toEqual([teamOrgId])
	expect(
		result.capabilities?.some(
			(capability) => capability.name === capabilityName,
		),
	).toBe(true)
})
