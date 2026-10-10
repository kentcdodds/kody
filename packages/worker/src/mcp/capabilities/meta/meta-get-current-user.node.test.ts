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
