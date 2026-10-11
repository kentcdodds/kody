import { expect, test } from 'vitest'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { metaGetCurrentUserCapability } from './meta-get-current-user.ts'

test('metaGetCurrentUser accepts an empty email for a team org caller', async () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		source: { kind: 'schedule', jobId: 'job-1' },
		user: {
			userId: personIdFromStored('a'.repeat(64)),
			email: '',
			username: 'acme',
			displayName: 'Acme',
		},
	})
	const result = await metaGetCurrentUserCapability.handler(
		{},
		{ env: {} as Env, callerContext },
	)
	expect(result.email).toBe('')
	expect(result.org).toEqual({ slug: 'acme' })
})

test('metaGetCurrentUser reports the member sender, not the team org, for member email', async () => {
	const beaId = 'b'.repeat(64)
	const missingTable = () => {
		throw new Error('no such table: user_roles')
	}
	const db = {
		prepare: (sql: string) => ({
			bind: () => ({
				first: async () =>
					sql.includes('FROM users')
						? {
								id: 7,
								email: 'bea@acme.example',
								username: 'bea',
								display_name: 'Bea',
								suspended_at: null,
								deleting_at: null,
								deleted_at: null,
							}
						: missingTable(),
				all: async () => missingTable(),
			}),
		}),
	} as unknown as D1Database
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		source: {
			kind: 'inbound-email',
			sourceId: 'inbox-1',
			sender: {
				kind: 'member',
				actor: { userId: personIdFromStored(beaId), username: 'bea' },
				role: 'member',
			},
		},
		user: {
			userId: personIdFromStored('a'.repeat(64)),
			email: '',
			username: 'acme',
			displayName: 'Acme',
		},
	})
	const result = await metaGetCurrentUserCapability.handler(
		{},
		{ env: { APP_DB: db } as Env, callerContext },
	)
	expect(result).toEqual({
		user_id: beaId,
		username: 'bea',
		email: 'bea@acme.example',
		display_name: 'Bea',
		org: { slug: 'acme' },
	})
})
