import { expect, test } from 'vitest'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'

test('package-app OAuth callback path is host-root reserved', () => {
	expect(packageAppOauthPaths.callback).toBe('/_kody/auth/callback')
	expect(packageAppOauthPaths.authorize).toBe('/oauth/package-app/authorize')
	expect(packageAppOauthPaths.login).toBe('/_kody/auth/login')
})
