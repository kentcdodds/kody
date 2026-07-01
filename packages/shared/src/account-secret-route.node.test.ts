import { expect, test } from 'vitest'
import {
	buildAccountSecretPath,
	parseAccountSecretPath,
} from './account-secret-route.ts'

test('account secret paths are generated with route-pattern segment encoding', () => {
	expect(
		buildAccountSecretPath({
			scope: 'user',
			name: 'github token',
		}),
	).toBe('/account/secrets/user/github%20token')

	expect(
		buildAccountSecretPath({
			scope: 'app',
			appId: 'package/id',
			name: 'api/key',
		}),
	).toBe('/account/secrets/app/package%2Fid/api%2Fkey')

	expect(
		buildAccountSecretPath({
			scope: 'session',
			sessionId: 'session id',
			name: 'token#value',
		}),
	).toBe('/account/secrets/session/session%20id/token%23value')
})

test('generated account secret paths still round-trip through the parser', () => {
	const path = buildAccountSecretPath({
		scope: 'app',
		appId: 'package/id',
		name: 'api/key',
	})

	expect(parseAccountSecretPath(path)).toEqual({
		id: 'app::package%2Fid::api%2Fkey',
		scope: 'app',
		appId: 'package/id',
		sessionId: null,
		name: 'api/key',
	})
})
