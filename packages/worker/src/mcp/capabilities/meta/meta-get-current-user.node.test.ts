import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { metaGetCurrentUserCapability } from './meta-get-current-user.ts'

test('meta_get_current_user returns signed-in identity and requires authentication', async () => {
	const result = await metaGetCurrentUserCapability.handler(
		{},
		{
			env: {} as Env,
			callerContext: createMcpCallerContext({
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'Ada Lovelace',
				},
			}),
		},
	)

	expect(result).toEqual({
		user_id: 'user-1',
		email: 'user@example.com',
		display_name: 'Ada Lovelace',
	})

	await expect(
		metaGetCurrentUserCapability.handler(
			{},
			{
				env: {} as Env,
				callerContext: createMcpCallerContext({
					baseUrl: 'https://heykody.dev',
				}),
			},
		),
	).rejects.toThrow('Authenticated MCP user is required for this capability.')
})
