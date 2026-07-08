import { expect, test } from 'vitest'
import {
	buildAccountSecretPath,
	parseAccountSecretPath,
} from './account-secret-route.ts'

test('account secret paths encode route segments and round-trip through the parser', () => {
	expect(
		buildAccountSecretPath({
			scope: 'user',
			name: 'github token',
		}),
	).toBe('/account/secrets/user/github%20token')

	const appPath = buildAccountSecretPath({
		scope: 'app',
		appId: 'package/id',
		name: 'api/key',
	})
	expect(appPath).toBe('/account/secrets/app/package%2Fid/api%2Fkey')
	expect(parseAccountSecretPath(appPath)).toEqual({
		id: 'app::package%2Fid::api%2Fkey',
		scope: 'app',
		appId: 'package/id',
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
})

test('account secret paths fail fast when scope binding ids are missing', () => {
	expect(() =>
		buildAccountSecretPath({
			scope: 'app',
			name: 'api/key',
		}),
	).toThrow(/appId is required/)
	expect(() =>
		buildAccountSecretPath({
			scope: 'session',
			name: 'api/key',
		}),
	).toThrow(/sessionId is required/)
})
