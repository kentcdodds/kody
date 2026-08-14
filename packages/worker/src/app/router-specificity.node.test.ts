import { expect, test } from 'vitest'
import { createRouter } from 'remix/router'
import { routePattern } from '#universal/route-pattern.ts'
import { routes } from '#universal/routes.ts'

function createStubHandler(name: string) {
	return {
		middleware: [],
		async handler() {
			return new Response(name)
		},
	}
}

test('router prefers static nested paths over dynamic siblings', async () => {
	const router = createRouter()
	router.get(
		routePattern(routes.accountMcpServersOauthCallback),
		createStubHandler('oauth-callback'),
	)
	router.get(
		routePattern(routes.accountMcpServerDetail),
		createStubHandler('server-detail'),
	)
	router.get(
		routePattern(routes.adminUserUsageApi),
		createStubHandler('usage-api'),
	)
	router.get(
		routePattern(routes.adminUserDetail),
		createStubHandler('user-detail'),
	)

	const oauthCallback = await router.fetch(
		new Request('http://localhost/account/mcp-servers/oauth/callback'),
	)
	expect(await oauthCallback.text()).toBe('oauth-callback')

	const serverDetail = await router.fetch(
		new Request('http://localhost/account/mcp-servers/my-server'),
	)
	expect(await serverDetail.text()).toBe('server-detail')

	const usageApi = await router.fetch(
		new Request('http://localhost/admin/users/usage.json'),
	)
	expect(await usageApi.text()).toBe('usage-api')

	const userDetail = await router.fetch(
		new Request('http://localhost/admin/users/42'),
	)
	expect(await userDetail.text()).toBe('user-detail')
})

test('delimiter-bounded params keep companion suffixes, hyphens, and encoded dots', async () => {
	const router = createRouter()
	router.get(routePattern(routes.blogPostApi), createStubHandler('blog-api'))
	router.get(
		routePattern(routes.communityDetailApi),
		createStubHandler('listing-api'),
	)
	router.get(routePattern(routes.profile), createStubHandler('profile'))
	router.get(
		routePattern(routes.accountSecretUserDetail),
		createStubHandler('secret'),
	)

	expect(
		await (
			await router.fetch(new Request('http://localhost/blog/hello-world.json'))
		).text(),
	).toBe('blog-api')
	expect(
		await (
			await router.fetch(
				new Request(
					'http://localhost/community/550e8400-e29b-41d4-a716-446655440000.json',
				),
			)
		).text(),
	).toBe('listing-api')
	expect(
		await (
			await router.fetch(new Request('http://localhost/@some-user'))
		).text(),
	).toBe('profile')
	expect(
		(await router.fetch(new Request('http://localhost/@john.doe'))).status,
	).toBe(404)
	expect(
		await (
			await router.fetch(
				new Request('http://localhost/account/secrets/user/google%2Eapi%2Ekey'),
			)
		).text(),
	).toBe('secret')
})
