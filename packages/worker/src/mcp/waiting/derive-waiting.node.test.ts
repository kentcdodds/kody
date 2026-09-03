import { expect, test } from 'vitest'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { collectWaitingSignals } from './derive-waiting.ts'

function createStubDb() {
	return {
		prepare() {
			return {
				bind() {
					return {
						async first() {
							return null
						},
						async all() {
							return { results: [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

const user = {
	userId: 11,
	stableUserId: 'user-aaa',
	email: 'waiting@example.com',
	emailVerified: true,
}

test('waiting signals read MCP OAuth grants from OAUTH_KV when the provider helpers are absent', async () => {
	const { kv } = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': JSON.stringify({
			id: 'grant-1',
			userId: 'user-aaa',
			clientId: 'host-client',
			scope: ['mcp'],
		}),
		'grant:user-bbb:grant-2': JSON.stringify({
			id: 'grant-2',
			userId: 'user-bbb',
			clientId: 'host-client',
			scope: ['mcp'],
		}),
	})
	const connected = await collectWaitingSignals({
		env: { APP_DB: createStubDb(), OAUTH_KV: kv } as Env,
		user,
	})
	expect(connected.onboardingRemaining).not.toContain('connect-agent')

	const disconnected = await collectWaitingSignals({
		env: { APP_DB: createStubDb(), OAUTH_KV: kv } as Env,
		user: { ...user, stableUserId: 'user-ccc' },
	})
	expect(disconnected.onboardingRemaining).toContain('connect-agent')

	const noOAuthSurface = await collectWaitingSignals({
		env: { APP_DB: createStubDb() } as Env,
		user,
	})
	expect(noOAuthSurface.onboardingRemaining).toContain('connect-agent')
})
