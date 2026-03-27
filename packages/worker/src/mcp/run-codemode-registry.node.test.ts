import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { buildCodemodeFns } from './run-codemode-registry.ts'

test('buildCodemodeFns resolves annotated home capability secret placeholders', async () => {
	let toolArguments: Record<string, unknown> | null = null
	const env = {
		HOME_CONNECTOR_SESSION: {
			idFromName(name: string) {
				return name
			},
			get() {
				return {
					async fetch(input: string | URL | Request, init?: RequestInit) {
						const url = new URL(
							typeof input === 'string'
								? input
								: input instanceof URL
									? input.toString()
									: input.url,
						)
						if (url.pathname.endsWith('/snapshot')) {
							return Response.json({
								connectorId: 'default',
								connectedAt: '2026-03-27T00:00:00.000Z',
								lastSeenAt: '2026-03-27T00:00:01.000Z',
								tools: [
									{
										name: 'lutron_set_credentials',
										title: 'Set Lutron Credentials',
										description: 'Store Lutron credentials.',
										inputSchema: {
											type: 'object',
											properties: {
												processorId: { type: 'string' },
												username: {
													type: 'string',
													'x-kody-secret': true,
												},
												password: {
													type: 'string',
													'x-kody-secret': true,
												},
											},
											required: ['processorId', 'username', 'password'],
										},
									},
								],
							})
						}

						if (url.pathname.endsWith('/rpc/tools-call')) {
							const requestBody = JSON.parse(String(init?.body ?? '{}')) as {
								arguments?: Record<string, unknown>
							}
							toolArguments = requestBody.arguments ?? null
							return Response.json({
								structuredContent: {
									ok: true,
								},
							})
						}

						throw new Error(`Unexpected fetch to ${url.pathname}`)
					},
				}
			},
		},
	} as unknown as Env

	const codemode = await buildCodemodeFns(
		env,
		createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			homeConnectorId: 'default',
		}),
		{
			resolveSecretValue: async (secret) => `${secret.name}-resolved`,
		},
	)

	await codemode.home_lutron_set_credentials({
		processorId: 'lutron-192-168-0-41',
		username: '{{secret:lutronUsername|scope=user}}',
		password: '{{secret:lutronPassword|scope=user}}',
	})

	expect(toolArguments).toEqual({
		processorId: 'lutron-192-168-0-41',
		username: 'lutronUsername-resolved',
		password: 'lutronPassword-resolved',
	})
})
