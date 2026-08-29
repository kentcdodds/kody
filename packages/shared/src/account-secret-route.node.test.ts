import { expect, test } from 'vitest'
import {
	buildAccountSecretPath,
	buildAccountSecretUrl,
	parseAccountSecretPath,
} from './account-secret-route.ts'

test('account secret paths encode route segments and round-trip through the parser', () => {
	expect(
		buildAccountSecretPath({
			scope: 'user',
			name: 'github token',
		}),
	).toBe('/account/secrets/user/github%20token')

	const packagePath = buildAccountSecretPath({
		scope: 'package',
		packageId: 'package/id',
		name: 'api/key',
	})
	expect(packagePath).toBe('/account/secrets/package/package%2Fid/api%2Fkey')
	expect(parseAccountSecretPath(packagePath)).toEqual({
		id: 'package::package%2Fid::api%2Fkey',
		scope: 'package',
		packageId: 'package/id',
		sessionId: null,
		name: 'api/key',
	})

	expect(
		buildAccountSecretPath({
			scope: 'session',
			sessionId: 'session id',
			name: 'token#value',
		}),
	).toBe('/account/secrets/session/session%20id/token%23value')

	const dottedPath = buildAccountSecretPath({
		scope: 'user',
		name: 'google.api.key',
	})
	expect(dottedPath).toBe('/account/secrets/user/google%2Eapi%2Ekey')
	expect(parseAccountSecretPath(dottedPath)).toEqual({
		id: 'user::::google.api.key',
		scope: 'user',
		packageId: null,
		sessionId: null,
		name: 'google.api.key',
	})

	const grokBotWakeName = 'grokBotWake.71e7550e-746d-417f-b253-05165975ff69'
	const grokBotWakePath = buildAccountSecretPath({
		scope: 'user',
		name: grokBotWakeName,
	})
	expect(grokBotWakePath).toBe(
		'/account/secrets/user/grokBotWake%2E71e7550e-746d-417f-b253-05165975ff69',
	)
	expect(grokBotWakePath).not.toContain(`/${grokBotWakeName}`)
	expect(parseAccountSecretPath(grokBotWakePath)).toEqual({
		id: `user::::${grokBotWakeName}`,
		scope: 'user',
		packageId: null,
		sessionId: null,
		name: grokBotWakeName,
	})

	const grokBotWakeUrl = buildAccountSecretUrl({
		baseUrl: 'https://kody.codes',
		scope: 'user',
		name: grokBotWakeName,
	})
	expect(grokBotWakeUrl).toBe(
		'https://kody.codes/account/secrets/user/grokBotWake%2E71e7550e-746d-417f-b253-05165975ff69',
	)
	expect(grokBotWakeUrl).not.toContain(`user/${grokBotWakeName}`)
})

test('account secret paths fail fast when scope binding ids are missing', () => {
	expect(() =>
		buildAccountSecretPath({
			scope: 'package',
			name: 'api/key',
		}),
	).toThrow(/packageId is required/)
	expect(() =>
		buildAccountSecretPath({
			scope: 'session',
			name: 'api/key',
		}),
	).toThrow(/sessionId is required/)
})
