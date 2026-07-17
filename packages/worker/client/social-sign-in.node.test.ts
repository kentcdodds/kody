import { expect, test } from 'vitest'
import { buildProviderStartPath } from './social-sign-in.ts'

test('buildProviderStartPath includes redirect and invite query params', () => {
	expect(buildProviderStartPath('github', null)).toBe('/auth/github')
	expect(buildProviderStartPath('github', '/community')).toBe(
		'/auth/github?redirectTo=%2Fcommunity',
	)
	expect(buildProviderStartPath('google', null, '  launch-one  ')).toBe(
		'/auth/google?inviteCode=launch-one',
	)
	expect(buildProviderStartPath('github', '/account', 'SOCIAL-INVITE')).toBe(
		'/auth/github?redirectTo=%2Faccount&inviteCode=SOCIAL-INVITE',
	)
	expect(buildProviderStartPath('github', null, '   ')).toBe('/auth/github')
})
