import { expect, test } from 'vitest'
import { createRouter } from 'remix/router'
import { routePattern } from '#app/route-pattern.ts'
import { routes } from '#app/routes.ts'

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
