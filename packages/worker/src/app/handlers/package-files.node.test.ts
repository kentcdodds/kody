import { expect, test, vi } from 'vitest'
import type * as AuthenticatedUser from '#app/authenticated-user.ts'
import type * as CommunityPackageRoute from '#app/community-package-route.ts'
import type * as PackageFilesData from '#app/package-files-data.ts'
import type * as PackagePage from '#app/package-page.ts'
import type * as PageAuth from '#app/page-auth.ts'
import type * as SsrRender from '#app/ssr-render.tsx'
import type * as PackageRegistryRepo from '#worker/package-registry/repo.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser:
		vi.fn<
			(
				...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
			) => Promise<unknown>
		>(),
	requireAuthenticatedPageUser:
		vi.fn<
			(
				...args: Parameters<typeof PageAuth.requireAuthenticatedPageUser>
			) => Promise<unknown>
		>(),
	loadCommunityPackageFilesData:
		vi.fn<
			(
				...args: Parameters<
					typeof PackageFilesData.loadCommunityPackageFilesData
				>
			) => Promise<unknown>
		>(),
	loadAccountPackageFilesData:
		vi.fn<
			(
				...args: Parameters<typeof PackageFilesData.loadAccountPackageFilesData>
			) => Promise<unknown>
		>(),
	loadAccessiblePackageFilesData:
		vi.fn<
			(
				...args: Parameters<
					typeof PackageFilesData.loadAccessiblePackageFilesData
				>
			) => Promise<unknown>
		>(),
	loadPackagePage:
		vi.fn<
			(
				...args: Parameters<typeof PackagePage.loadPackagePage>
			) => Promise<unknown>
		>(),
	getSavedPackageById:
		vi.fn<
			(
				...args: Parameters<typeof PackageRegistryRepo.getSavedPackageById>
			) => Promise<unknown>
		>(),
	resolveCommunityFilesRoute:
		vi.fn<
			(
				...args: Parameters<
					typeof CommunityPackageRoute.resolveCommunityFilesRoute
				>
			) => Promise<unknown>
		>(),
	renderAppPage: vi.fn<typeof SsrRender.renderAppPage>(
		async () => new Response('ok'),
	),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (
		...args: Parameters<typeof PageAuth.requireAuthenticatedPageUser>
	) => mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Parameters<typeof PackagePage.loadPackagePage>) =>
		mockModule.loadPackagePage(...args),
}))

vi.mock('#app/community-package-route.ts', () => ({
	resolveCommunityFilesRoute: (
		...args: Parameters<typeof CommunityPackageRoute.resolveCommunityFilesRoute>
	) => mockModule.resolveCommunityFilesRoute(...args),
	resolveCanonicalFilesPath: async () => null,
	treeHrefFromPackageHome: (
		packageHref: string,
		input: { ref?: string; relativePath?: string },
	) => {
		const ref = input.ref?.trim() || 'main'
		const relativePath = input.relativePath?.trim()
		return relativePath
			? `${packageHref}/tree/${ref}/${relativePath}`
			: `${packageHref}/tree/${ref}`
	},
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (
		...args: Parameters<typeof PackageRegistryRepo.getSavedPackageById>
	) => mockModule.getSavedPackageById(...args),
}))

vi.mock('#app/package-files-data.ts', () => ({
	loadCommunityPackageFilesData: (
		...args: Parameters<typeof PackageFilesData.loadCommunityPackageFilesData>
	) => mockModule.loadCommunityPackageFilesData(...args),
	loadAccountPackageFilesData: (
		...args: Parameters<typeof PackageFilesData.loadAccountPackageFilesData>
	) => mockModule.loadAccountPackageFilesData(...args),
	loadAccessiblePackageFilesData: (
		...args: Parameters<typeof PackageFilesData.loadAccessiblePackageFilesData>
	) => mockModule.loadAccessiblePackageFilesData(...args),
	readPackageFilesSelectedPath: (requestUrl: string) => {
		const url = new URL(requestUrl, 'http://localhost')
		const raw = url.searchParams.get('path')
		if (raw == null) return ''
		if (raw.includes('..')) return null
		return raw
	},
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Parameters<typeof SsrRender.renderAppPage>) =>
		mockModule.renderAppPage(...args),
}))

const {
	createAccountPackageFilesApiHandler,
	createAccountPackageFilesHandler,
	createCommunityPackageFilesApiHandler,
	createCommunityPackageFilesHandler,
} = await import('./package-files.ts')

const filesPayload = {
	ok: true,
	title: '@owner/demo',
	backHref: '/@owner/demo',
	backLabel: 'Repo',
	filesBasePath: '/@owner/demo/tree/main',
	selectedPath: 'src/index.ts',
	kind: 'file',
	paths: ['src/index.ts'],
	children: [],
	content: 'export const answer = 42\n',
	contentPath: 'src/index.ts',
	contentKind: 'code',
	language: 'ts',
}

type Handler = { handler(context: never): Promise<Response> }

function call(
	handler: Handler,
	path: string,
	params: Record<string, string>,
	headers: Record<string, string> = {},
) {
	const url = new URL(`https://example.com${path}`)
	return handler.handler({
		request: new Request(url, { headers }),
		params,
		url,
	} as never)
}

test('community files API resolves the package page and rejects traversal', async () => {
	const handler = createCommunityPackageFilesApiHandler({} as Env)
	const params = { username: 'owner', kodyId: 'demo' }
	const filesJson = '/profiles/owner/packages/demo/files.json'
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'owner',
		kodyId: 'demo',
		listing: { listing: { id: 'listing-1' } },
		viewerIsOwner: false,
	})
	mockModule.loadAccessiblePackageFilesData.mockResolvedValue(filesPayload)

	const success = await call(handler, `${filesJson}?path=src/index.ts`, params)
	expect(success.status).toBe(200)
	expect(await success.json()).toEqual(filesPayload)
	// Anonymous trees are shared; a session cookie makes the same URL private.
	expect(success.headers.get('Cache-Control')).toBe('public, max-age=60')
	expect(success.headers.get('Vary')).toBe('Cookie')
	const signedIn = await call(
		handler,
		`${filesJson}?path=src/index.ts`,
		params,
		{
			Cookie: 'kody_session=abc',
		},
	)
	expect(signedIn.status).toBe(200)
	expect(signedIn.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.loadAccessiblePackageFilesData).toHaveBeenCalledWith({
		env: {},
		request: expect.any(Request),
		username: 'owner',
		kodyId: 'demo',
		selectedPath: 'src/index.ts',
		ref: '',
		serverTiming: expect.any(Array),
	})

	const traversal = await call(handler, `${filesJson}?path=../secret`, params)
	expect(traversal.status).toBe(400)

	mockModule.loadAccessiblePackageFilesData.mockResolvedValue(null)
	expect((await call(handler, filesJson, params)).status).toBe(404)
})

test('account files HTML and JSON redirect to the package tree', async () => {
	const htmlHandler = createAccountPackageFilesHandler({} as Env)
	const apiHandler = createAccountPackageFilesApiHandler({} as Env)
	const params = { packageId: 'pkg-1' }

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await call(
		apiHandler,
		'/account/packages/pkg-1/files.json',
		params,
	)
	expect(unauthorized.status).toBe(401)
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()

	const owner = { mcpUser: { userId: 'stable-user-1' }, username: 'owner' }
	mockModule.readAuthenticatedAppUser.mockResolvedValue(owner)
	mockModule.requireAuthenticatedPageUser.mockResolvedValue(owner)
	mockModule.getSavedPackageById.mockResolvedValue({ kodyId: 'demo' })

	const json = await call(
		apiHandler,
		'/account/packages/pkg-1/files.json?path=src/index.ts',
		params,
	)
	expect(json.status).toBe(404)
	expect(await json.json()).toEqual({
		ok: false,
		error: 'Package files moved.',
		redirectTo: '/@owner/demo/tree/main/src/index.ts',
	})
	expect(mockModule.loadAccountPackageFilesData).not.toHaveBeenCalled()

	const html = await call(htmlHandler, '/account/packages/pkg-1/files', params)
	expect(html.status).toBe(302)
	expect(html.headers.get('location')).toBe(
		'https://example.com/@owner/demo/tree/main',
	)
})

test('unlisted leftover tree redirects stay private; listed leftovers stay public', async () => {
	const handler = createCommunityPackageFilesHandler({} as Env)
	const cases = [
		{
			kodyId: 'friction-log',
			shared: false,
			status: 302,
			cacheControl: 'private, no-store',
		},
		{
			kodyId: 'sentry',
			shared: true,
			status: 301,
			cacheControl: 'public, max-age=3600',
		},
	]
	for (const { kodyId, shared, status, cacheControl } of cases) {
		mockModule.resolveCommunityFilesRoute.mockResolvedValue({
			kind: 'redirect',
			to: `/@owner/${kodyId}/tree/main`,
			shared,
		})
		const hop = await handler.handler({
			request: new Request(`https://example.com/@owner/${kodyId}/files`),
		} as never)
		expect({
			status: hop.status,
			location: hop.headers.get('location'),
			cacheControl: hop.headers.get('cache-control'),
		}).toEqual({
			status,
			location: `https://example.com/@owner/${kodyId}/tree/main`,
			cacheControl,
		})
	}
})
