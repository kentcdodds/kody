import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { emailDomain } from './domain.ts'

function createContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User Example',
			},
		}),
	}
}

test('email domain exposes inbox, message, and send capabilities', () => {
	expect(emailDomain.name).toBe('email')
	expect(emailDomain.capabilities.map((capability) => capability.name)).toEqual(
		expect.arrayContaining([
			'email_inbox_create',
			'email_inbox_list',
			'email_message_list',
			'email_message_get',
			'email_send',
			'email_reply',
			'email_sender_identity_verify',
		]),
	)
})

test('email capabilities require a signed-in user context', async () => {
	const capability = emailDomain.capabilities.find(
		(candidate) => candidate.name === 'email_message_list',
	)
	if (!capability) throw new Error('email_message_list capability missing')

	await expect(
		capability.handler(
			{ limit: 1 },
			{
				...createContext(),
				callerContext: createMcpCallerContext({
					baseUrl: 'https://example.com',
				}),
			},
		),
	).rejects.toThrow(/Authenticated MCP user/)
})
