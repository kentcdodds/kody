import { expect, test } from 'vitest'
import {
	createLegacyOrgPackagesApiRedirectHandler,
	createLegacyOrgPackagesRedirectHandler,
	resolveLegacyOrgPackagesLocation,
} from './legacy-org-packages-redirect.ts'

test('legacy /-/packages redirects to /-/repositories and keeps the query', () => {
	expect(
		resolveLegacyOrgPackagesLocation(
			new URL('https://kody.test/@acme/-/packages?q=hello&visibility=public'),
		),
	).toBe('/@acme/-/repositories?q=hello&visibility=public')
	expect(
		resolveLegacyOrgPackagesLocation(
			new URL('https://kody.test/@acme/-/packages.json?sort=name'),
		),
	).toBe('/@acme/-/repositories.json?sort=name')
	expect(
		resolveLegacyOrgPackagesLocation(
			new URL('https://kody.test/@acme/-/packages/'),
		),
	).toBe('/@acme/-/repositories')
	expect(
		resolveLegacyOrgPackagesLocation(
			new URL('https://kody.test/@acme/packages/app'),
		),
	).toBeNull()
})

test('legacy handlers respond 301 with Location', async () => {
	const env = {} as Env
	const html = await createLegacyOrgPackagesRedirectHandler(env).handler({
		request: new Request(
			'https://kody.test/@jane/-/packages?package=saved&q=x',
		),
		params: { orgSlug: 'jane' },
	} as never)
	expect(html.status).toBe(301)
	expect(html.headers.get('Location')).toBe(
		'/@jane/-/repositories?package=saved&q=x',
	)

	const api = await createLegacyOrgPackagesApiRedirectHandler(env).handler({
		request: new Request('https://kody.test/@jane/-/packages.json?dir=asc'),
		params: { orgSlug: 'jane' },
	} as never)
	expect(api.status).toBe(301)
	expect(api.headers.get('Location')).toBe('/@jane/-/repositories.json?dir=asc')
})
