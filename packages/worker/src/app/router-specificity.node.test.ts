import { expect, test } from 'vitest'
import { createRouter } from 'remix/router'
import { route } from 'remix/routes'
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

/** Registers each route with a stub that answers its own route name. */
function makeRouter(names: Array<keyof typeof routes>) {
	const router = createRouter()
	for (const name of names) {
		router.get(routePattern(routes[name]), createStubHandler(name))
	}
	return async (path: string) => {
		const response = await router.fetch(new Request(`http://localhost${path}`))
		return response.ok ? await response.text() : response.status
	}
}

async function resolveAll(
	resolve: (path: string) => Promise<string | number>,
	cases: Array<[path: string, ...unknown[]]>,
) {
	const resolved = new Array<[string, string | number]>()
	for (const [path] of cases) resolved.push([path, await resolve(path)])
	return resolved
}

const uuid = '550e8400-e29b-41d4-a716-446655440000'

test('router prefers static nested paths and package files over dynamic siblings', async () => {
	const resolve = makeRouter([
		'accountMcpServersOauthCallback',
		'accountMcpServerLogo',
		'accountMcpServerDetail',
		'adminUserUsageApi',
		'adminUserDetail',
		'communityPackage',
		'communityPackageFiles',
		'communityPackageRaw',
		'communityDetailRaw',
		'communityPackageAsset',
		'communityDetailAsset',
		'communityPackageApprovePublish',
		'accountPackageDetail',
		'accountPackageApprovePublish',
		'accountPackageFiles',
		'communityDetail',
		'communityDetailFiles',
	])
	const cases: Array<[string, keyof typeof routes]> = [
		['/account/mcp-servers/oauth/callback', 'accountMcpServersOauthCallback'],
		[`/account/mcp-servers/logos/${uuid}`, 'accountMcpServerLogo'],
		['/account/mcp-servers/my-server', 'accountMcpServerDetail'],
		['/admin/users/usage.json', 'adminUserUsageApi'],
		['/admin/users/42', 'adminUserDetail'],
		['/@kentcdodds/devin', 'communityPackage'],
		['/@kentcdodds/devin/files/src/index.ts', 'communityPackageFiles'],
		['/@kentcdodds/devin/raw/main/docs/logo.png', 'communityPackageRaw'],
		['/@kentcdodds/devin/assets/docs/poster.png', 'communityPackageAsset'],
		[`/community/${uuid}/raw/docs/logo.png`, 'communityDetailRaw'],
		[`/community/${uuid}/assets/docs/poster.png`, 'communityDetailAsset'],
		['/@kentcdodds/devin/approve-publish', 'communityPackageApprovePublish'],
		['/account/packages/pkg-1', 'accountPackageDetail'],
		['/account/packages/pkg-1/approve-publish', 'accountPackageApprovePublish'],
		['/account/packages/pkg-1/files/README.md', 'accountPackageFiles'],
		[`/community/${uuid}/files/src/lib.ts`, 'communityDetailFiles'],
	]
	expect(await resolveAll(resolve, cases)).toEqual(cases)
})

test('organization resource pages outrank a package url with the same shape', async () => {
	const resolve = makeRouter([
		'orgSecrets',
		'orgPackages',
		'communityPackage',
		'profile',
	])
	expect(await resolve('/@ada/secrets')).toBe('orgSecrets')
	expect(await resolve('/@ada/secrets/new')).toBe('orgSecrets')
	expect(await resolve('/@ada/packages')).toBe('orgPackages')
	expect(await resolve('/@ada/devin')).toBe('communityPackage')
	expect(await resolve('/@ada')).toBe('profile')
})

test('the create-organization form posts to the create action, not back to the page', async () => {
	const router = createRouter()
	router.map(
		route({
			accountOrganizationsNew: routes.accountOrganizationsNew,
			accountOrganizationsNewPost: routes.accountOrganizationsNewPost,
		}),
		{
			actions: {
				accountOrganizationsNew: createStubHandler('page'),
				accountOrganizationsNewPost: createStubHandler('create'),
			},
		},
	)
	const resolve = async (method: string) => {
		const response = await router.fetch(
			new Request('http://localhost/account/organizations/new', { method }),
		)
		return response.text()
	}
	expect(await resolve('GET')).toBe('page')
	expect(await resolve('POST')).toBe('create')
})

test('method mismatches return 405 with Allow and GET routes serve HEAD', async () => {
	const router = createRouter({
		async defaultHandler() {
			return new Response('not-found', { status: 404 })
		},
	})
	router.post(routePattern(routes.logout), createStubHandler('logout'))
	router.get(routePattern(routes.blogRss), {
		middleware: [],
		async handler() {
			return new Response('<rss/>', {
				headers: { 'Content-Type': 'application/rss+xml' },
			})
		},
	})

	const methodMismatch = await router.fetch(
		new Request('http://localhost/logout'),
	)
	expect(methodMismatch.status).toBe(405)
	expect(methodMismatch.headers.get('Allow')).toBe('POST')

	const head = await router.fetch(
		new Request('http://localhost/blog/rss.xml', { method: 'HEAD' }),
	)
	expect(head.status).toBe(200)
	expect(head.headers.get('Content-Type')).toBe('application/rss+xml')
	expect(await head.text()).toBe('')

	const unmatched = await router.fetch(
		new Request('http://localhost/definitely-not-a-route'),
	)
	expect(unmatched.status).toBe(404)
	expect(await unmatched.text()).toBe('not-found')
})

test('delimiter-bounded params keep companion suffixes and only match dotted ids when encoded', async () => {
	const resolve = makeRouter([
		'blogPostApi',
		'communityDetailApi',
		'profile',
		'profileAvatar',
		'profileOgImage',
		'accountSecretUserDetail',
		'accountIntegrationDetail',
		'integrationLogo',
		'adminPlatformIntegrationDetail',
		'accountJobDetail',
		'accountWorkflowDetail',
		'accountActivityDetail',
	])
	const avatarHash =
		'00e495130208345dcc438bce0102f73a6e5cef01085a930c9c9ed2651a67b8d9'
	const cases: Array<[string, keyof typeof routes | 404]> = [
		['/blog/hello-world.json', 'blogPostApi'],
		[`/community/${uuid}.json`, 'communityDetailApi'],
		['/@some-user', 'profile'],
		['/@john.doe', 404],
		[`/profiles/kentcdodds/avatar/${avatarHash}.jpg`, 'profileAvatar'],
		['/profiles/alice/og.png', 'profileOgImage'],
		['/account/secrets/user/google%2Eapi%2Ekey', 'accountSecretUserDetail'],
		['/account/integrations/google.personal', 404],
		['/account/integrations/google%2Epersonal', 'accountIntegrationDetail'],
		['/integrations/logos/openai.com', 404],
		['/integrations/logos/openai%2Ecom', 'integrationLogo'],
		['/admin/platform-integrations/openai.com', 404],
		[
			'/admin/platform-integrations/openai%2Ecom',
			'adminPlatformIntegrationDetail',
		],
		['/account/jobs/package-job:pkg:daily.backup', 404],
		['/account/jobs/package-job%3Apkg%3Adaily%2Ebackup', 'accountJobDetail'],
		['/account/activity/run-1', 'accountActivityDetail'],
		['/account/workflows/dynwf-example', 'accountWorkflowDetail'],
	]
	expect(await resolveAll(resolve, cases)).toEqual(cases)
})
