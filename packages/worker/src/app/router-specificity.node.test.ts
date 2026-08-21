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

test('router prefers static nested paths and package files over dynamic siblings', async () => {
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
	router.get(
		routePattern(routes.communityPackage),
		createStubHandler('listing'),
	)
	router.get(
		routePattern(routes.communityPackageFiles),
		createStubHandler('community-files'),
	)
	router.get(
		routePattern(routes.accountPackageDetail),
		createStubHandler('package-detail'),
	)
	router.get(
		routePattern(routes.accountPackageFiles),
		createStubHandler('account-files'),
	)
	router.get(
		routePattern(routes.communityDetail),
		createStubHandler('listing-uuid'),
	)
	router.get(
		routePattern(routes.communityDetailFiles),
		createStubHandler('listing-uuid-files'),
	)

	expect(
		await (
			await router.fetch(
				new Request('http://localhost/account/mcp-servers/oauth/callback'),
			)
		).text(),
	).toBe('oauth-callback')
	expect(
		await (
			await router.fetch(
				new Request('http://localhost/account/mcp-servers/my-server'),
			)
		).text(),
	).toBe('server-detail')
	expect(
		await (
			await router.fetch(new Request('http://localhost/admin/users/usage.json'))
		).text(),
	).toBe('usage-api')
	expect(
		await (
			await router.fetch(new Request('http://localhost/admin/users/42'))
		).text(),
	).toBe('user-detail')
	expect(
		await (
			await router.fetch(new Request('http://localhost/@kentcdodds/devin'))
		).text(),
	).toBe('listing')
	expect(
		await (
			await router.fetch(
				new Request('http://localhost/@kentcdodds/devin/files/src/index.ts'),
			)
		).text(),
	).toBe('community-files')
	expect(
		await (
			await router.fetch(new Request('http://localhost/account/packages/pkg-1'))
		).text(),
	).toBe('package-detail')
	expect(
		await (
			await router.fetch(
				new Request('http://localhost/account/packages/pkg-1/files/README.md'),
			)
		).text(),
	).toBe('account-files')
	expect(
		await (
			await router.fetch(
				new Request(
					'http://localhost/community/550e8400-e29b-41d4-a716-446655440000/files/src/lib.ts',
				),
			)
		).text(),
	).toBe('listing-uuid-files')
})

test('delimiter-bounded params keep companion suffixes and encode dotted ids', async () => {
	const router = createRouter()
	router.get(routePattern(routes.blogPostApi), createStubHandler('blog-api'))
	router.get(
		routePattern(routes.communityDetailApi),
		createStubHandler('listing-api'),
	)
	router.get(routePattern(routes.profile), createStubHandler('profile'))
	router.get(
		routePattern(routes.profileAvatar),
		createStubHandler('profile-avatar'),
	)
	router.get(
		routePattern(routes.profileOgImage),
		createStubHandler('profile-og'),
	)
	router.get(
		routePattern(routes.accountSecretUserDetail),
		createStubHandler('secret'),
	)
	router.get(
		routePattern(routes.accountIntegrationDetail),
		createStubHandler('integration'),
	)
	router.get(routePattern(routes.integrationLogo), createStubHandler('logo'))
	router.get(
		routePattern(routes.adminPlatformIntegrationDetail),
		createStubHandler('platform-integration'),
	)
	router.get(routePattern(routes.accountJobDetail), createStubHandler('job'))
	router.get(
		routePattern(routes.accountWorkflowDetail),
		createStubHandler('workflow'),
	)
	router.get(
		routePattern(routes.accountActivityDetail),
		createStubHandler('activity'),
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
				new Request(
					'http://localhost/profiles/kentcdodds/avatar/00e495130208345dcc438bce0102f73a6e5cef01085a930c9c9ed2651a67b8d9.jpg',
				),
			)
		).text(),
	).toBe('profile-avatar')
	expect(
		await (
			await router.fetch(new Request('http://localhost/profiles/alice/og.png'))
		).text(),
	).toBe('profile-og')
	expect(
		await (
			await router.fetch(
				new Request('http://localhost/account/secrets/user/google%2Eapi%2Ekey'),
			)
		).text(),
	).toBe('secret')

	expect(
		(
			await router.fetch(
				new Request('http://localhost/account/integrations/google.personal'),
			)
		).status,
	).toBe(404)
	expect(
		await (
			await router.fetch(
				new Request('http://localhost/account/integrations/google%2Epersonal'),
			)
		).text(),
	).toBe('integration')
	expect(
		(
			await router.fetch(
				new Request('http://localhost/integrations/logos/openai.com'),
			)
		).status,
	).toBe(404)
	expect(
		await (
			await router.fetch(
				new Request('http://localhost/integrations/logos/openai%2Ecom'),
			)
		).text(),
	).toBe('logo')
	expect(
		(
			await router.fetch(
				new Request('http://localhost/admin/platform-integrations/openai.com'),
			)
		).status,
	).toBe(404)
	expect(
		await (
			await router.fetch(
				new Request(
					'http://localhost/admin/platform-integrations/openai%2Ecom',
				),
			)
		).text(),
	).toBe('platform-integration')
	expect(
		(
			await router.fetch(
				new Request(
					'http://localhost/account/jobs/package-job:pkg:daily.backup',
				),
			)
		).status,
	).toBe(404)
	expect(
		await (
			await router.fetch(
				new Request(
					'http://localhost/account/jobs/package-job%3Apkg%3Adaily%2Ebackup',
				),
			)
		).text(),
	).toBe('job')
	expect(
		await (
			await router.fetch(new Request('http://localhost/account/activity/run-1'))
		).text(),
	).toBe('activity')
	expect(
		await (
			await router.fetch(
				new Request('http://localhost/account/workflows/dynwf-example'),
			)
		).text(),
	).toBe('workflow')
})
