import { expect, test } from 'vitest'
import { createRouter } from 'remix/router'
import { matchRoute } from '#client/client-router.tsx'
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

test('client route matching prefers static nested paths over dynamic siblings', () => {
	const oauthCallbackRoute = 'oauth-callback' as unknown as JSX.Element
	const serverDetailRoute = 'server-detail' as unknown as JSX.Element
	const usageApiRoute = 'usage-api' as unknown as JSX.Element
	const userDetailRoute = 'user-detail' as unknown as JSX.Element

	const mcpRoutes = {
		[routePattern(routes.accountMcpServerDetail)]: serverDetailRoute,
		[routePattern(routes.accountMcpServersOauthCallback)]: oauthCallbackRoute,
	}
	expect(matchRoute('/account/mcp-servers/oauth/callback', mcpRoutes)).toBe(
		oauthCallbackRoute,
	)
	expect(matchRoute('/account/mcp-servers/my-server', mcpRoutes)).toBe(
		serverDetailRoute,
	)

	const adminRoutes = {
		[routePattern(routes.adminUserDetail)]: userDetailRoute,
		[routePattern(routes.adminUserUsageApi)]: usageApiRoute,
	}
	expect(matchRoute('/admin/users/usage.json', adminRoutes)).toBe(usageApiRoute)
	expect(matchRoute('/admin/users/42', adminRoutes)).toBe(userDetailRoute)
})
