import { expect, test } from 'vitest'
import { createChatMcpCallerContext } from './chat-agent-mcp-context.ts'

test('chat MCP caller context includes the default home remote connector', () => {
	const callerContext = createChatMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-123',
			email: 'me@kentcdodds.com',
			displayName: 'Kent',
		},
	})

	expect(callerContext).toMatchObject({
		baseUrl: 'https://heykody.dev',
		remoteConnectors: [{ kind: 'home', instanceId: 'default' }],
		user: {
			userId: 'user-123',
			email: 'me@kentcdodds.com',
			displayName: 'Kent',
		},
	})
})
