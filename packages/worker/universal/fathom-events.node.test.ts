import { expect, test } from 'vitest'
import {
	accountCreatedQueryParam,
	withAccountCreatedQuery,
} from './fathom-events.ts'

test('withAccountCreatedQuery appends the client signal without dropping path', () => {
	expect(withAccountCreatedQuery('/onboarding')).toBe(
		`/onboarding?${accountCreatedQueryParam}=1`,
	)
	expect(withAccountCreatedQuery('/onboarding?x=1')).toBe(
		`/onboarding?x=1&${accountCreatedQueryParam}=1`,
	)
})
