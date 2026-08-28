import { expect, test } from 'vitest'
import {
	accountCreatedQueryParam,
	fathomEventNames,
	withAccountCreatedQuery,
} from './fathom-events.ts'

test('fathom event names stay public-site only', () => {
	expect(fathomEventNames).toEqual({
		signupStarted: 'signup_started',
		accountCreated: 'account_created',
	})
	expect(Object.values(fathomEventNames)).not.toContain('execute')
	expect(Object.values(fathomEventNames)).not.toContain('mcp_connected')
})

test('withAccountCreatedQuery appends the client signal without dropping path', () => {
	expect(withAccountCreatedQuery('/onboarding')).toBe(
		`/onboarding?${accountCreatedQueryParam}=1`,
	)
	expect(withAccountCreatedQuery('/onboarding?x=1')).toBe(
		`/onboarding?x=1&${accountCreatedQueryParam}=1`,
	)
})
