import { expect, test } from 'vitest'
import {
	formatPackageAppOauthClientId,
	parsePackageAppOauthClientId,
} from '#app/package-app-oauth-client-id.ts'

test('package-app OAuth client ids are owner/leaf with optional @', () => {
	expect(parsePackageAppOauthClientId('@kentcdodds/world-builder')).toEqual({
		username: 'kentcdodds',
		kodyId: 'world-builder',
		clientId: 'kentcdodds/world-builder',
	})
	expect(parsePackageAppOauthClientId('kentcdodds/world-builder')).toEqual({
		username: 'kentcdodds',
		kodyId: 'world-builder',
		clientId: 'kentcdodds/world-builder',
	})
	expect(parsePackageAppOauthClientId('bad')).toBeNull()
	expect(parsePackageAppOauthClientId('ab/x')).toBeNull()
	expect(parsePackageAppOauthClientId('kentcdodds/a/b')).toBeNull()
	expect(parsePackageAppOauthClientId('kentcdodds/%ZZdemo')).toBeNull()
	expect(
		formatPackageAppOauthClientId({
			username: 'KentCDodds',
			kodyId: 'demo',
		}),
	).toBe('kentcdodds/demo')
})
