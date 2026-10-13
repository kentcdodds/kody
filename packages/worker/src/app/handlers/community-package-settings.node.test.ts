import { expect, test, vi } from 'vitest'
import type * as PackagePage from '#app/package-page.ts'
import type * as SsrRender from '#app/ssr-render.tsx'

const mockModule = vi.hoisted(() => ({
	loadPackagePage:
		vi.fn<
			(
				...args: Parameters<typeof PackagePage.loadPackagePage>
			) => Promise<unknown>
		>(),
	requireAuthenticatedPageUser: vi.fn<
		(...args: Array<unknown>) => Promise<unknown>
	>(async () => ({ username: 'kentcdodds' })),
	loadPackageMappingScopeForViewer: vi.fn<
		(...args: Array<unknown>) => Promise<unknown>
	>(async () => ({ baseUrl: 'https://example.com' })),
	renderAppPage: vi.fn<typeof SsrRender.renderAppPage>(
		async (input) =>
			new Response('ok', {
				status: input.status ?? 200,
			}),
	),
}))

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Parameters<typeof PackagePage.loadPackagePage>) =>
		mockModule.loadPackagePage(...args),
	ownerPackageForClient: (
		input: Parameters<typeof PackagePage.ownerPackageForClient>[0],
	) => input.ownerPackage,
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Parameters<typeof SsrRender.renderAppPage>) =>
		mockModule.renderAppPage(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/package-credentials-access.ts', () => ({
	loadPackageMappingScopeForViewer: (...args: Array<unknown>) =>
		mockModule.loadPackageMappingScopeForViewer(...args),
}))

vi.mock('#app/frame-registrations.ts', () => ({}))
vi.mock('#app/frame-registry.ts', () => ({
	handleFrameRequest: async () => null,
}))

const {
	createCommunityPackageCredentialApprovalHandler,
	createCommunityPackageCredentialsHandler,
	createCommunityPackageSettingsHandler,
} = await import('./community-detail.tsx')

test('package settings 404 unless the viewer can manage the package', async () => {
	const handler = createCommunityPackageSettingsHandler({} as Env)
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		listing: null,
		ownerPackage: { id: 'pkg-1', name: 'friction-log', isPrivate: true },
		viewerIsOwner: false,
		viewerCanManage: false,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
	})
	const requestSettings = () =>
		handler.handler({
			request: new Request(
				'https://example.com/@kentcdodds/friction-log/settings',
			),
			params: { username: 'kentcdodds', kodyId: 'friction-log' },
			url: new URL('https://example.com/@kentcdodds/friction-log/settings'),
		} as never)

	const stranger = await requestSettings()
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({ notFound: true, status: 404 }),
	)
	expect(stranger.status).toBe(404)

	mockModule.renderAppPage.mockClear()
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'acme',
		kodyId: 'friction-log',
		listing: null,
		ownerPackage: { id: 'pkg-1', name: 'friction-log', isPrivate: true },
		viewerIsOwner: true,
		viewerCanManage: false,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
	})
	const reader = await requestSettings()
	expect(reader.status).toBe(404)

	mockModule.renderAppPage.mockClear()
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		listing: null,
		ownerPackage: {
			id: 'pkg-1',
			name: 'friction-log',
			description: '',
			isPrivate: true,
			kodyId: 'friction-log',
		},
		viewerIsOwner: true,
		viewerCanManage: true,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
	})
	const owner = await handler.handler({
		request: new Request(
			'https://example.com/@kentcdodds/friction-log/settings',
		),
		params: { username: 'kentcdodds', kodyId: 'friction-log' },
		url: new URL('https://example.com/@kentcdodds/friction-log/settings'),
	} as never)
	expect(owner.status).toBe(200)
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({
			title: 'friction-log settings',
			loaderData: expect.objectContaining({
				communityDetailShell: expect.objectContaining({
					kodyId: 'friction-log',
					viewerIsOwner: true,
					viewerCanManage: true,
					isPrivate: true,
					listingId: null,
					defaultBranch: null,
				}),
			}),
		}),
	)
})

test('package settings Files tab uses the listing default branch and id', async () => {
	const handler = createCommunityPackageSettingsHandler({} as Env)
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'packages',
		listing: {
			listing: {
				id: 'listing-1',
				kodyId: 'packages',
				defaultBranch: 'develop',
			},
			ownerProfilePublic: false,
		},
		ownerPackage: {
			id: 'pkg-1',
			name: 'packages',
			description: 'Reserved kody id',
			isPrivate: true,
			kodyId: 'packages',
		},
		viewerIsOwner: true,
		viewerCanManage: true,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
		ownerProfilePublic: false,
	})
	const owner = await handler.handler({
		request: new Request('https://example.com/@kentcdodds/packages/settings'),
		params: { username: 'kentcdodds', kodyId: 'packages' },
		url: new URL('https://example.com/@kentcdodds/packages/settings'),
	} as never)
	expect(owner.status).toBe(200)
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({
			loaderData: expect.objectContaining({
				communityDetailShell: expect.objectContaining({
					kodyId: 'packages',
					listingId: 'listing-1',
					defaultBranch: 'develop',
					ownerProfilePublic: false,
				}),
			}),
		}),
	)
})

test('package credential tabs 404 outside the package org or on plain repos and keep the tab on a move', async () => {
	const handler = createCommunityPackageCredentialsHandler(
		{} as Env,
		'mappings',
	)
	const requestTab = () =>
		handler.handler({
			request: new Request('https://example.com/@kentcdodds/digest/mappings'),
			params: { username: 'kentcdodds', kodyId: 'digest' },
			url: new URL('https://example.com/@kentcdodds/digest/mappings'),
		} as never)
	const page = {
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'digest',
		listing: null,
		ownerPackage: { id: 'pkg-1', name: 'digest', isPrivate: true },
		hasPackage: true,
		viewerIsOwner: false,
		viewerCanManage: false,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
	}

	mockModule.renderAppPage.mockClear()
	mockModule.loadPackagePage.mockResolvedValue(page)
	expect((await requestTab()).status).toBe(404)

	mockModule.loadPackagePage.mockResolvedValue({
		...page,
		viewerIsOwner: true,
		hasPackage: false,
	})
	expect((await requestTab()).status).toBe(404)

	mockModule.renderAppPage.mockClear()
	mockModule.loadPackagePage.mockResolvedValue({ ...page, viewerIsOwner: true })
	const member = await requestTab()
	expect(member.status).toBe(200)
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({ title: 'digest default mappings' }),
	)
	expect(mockModule.renderAppPage.mock.calls[0]?.[0].loaderData).toBeUndefined()

	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'redirect',
		to: '/@acme/digest',
		shared: false,
	})
	const moved = await requestTab()
	expect(moved.status).toBe(302)
	expect(moved.headers.get('location')).toBe(
		'https://example.com/@acme/digest/mappings',
	)
})

test('the credential approval page needs a session and package:execute, and keeps the proposal across a move', async () => {
	const handler = createCommunityPackageCredentialApprovalHandler({} as Env)
	const pageUrl =
		'https://example.com/@kentcdodds/digest/approve-credentials?default%5Bgithub%5D=bot'
	const requestPage = () =>
		handler.handler({
			request: new Request(pageUrl),
			params: { username: 'kentcdodds', kodyId: 'digest' },
			url: new URL(pageUrl),
		} as never)

	mockModule.requireAuthenticatedPageUser.mockResolvedValueOnce(
		new Response(null, { status: 302, headers: { location: '/login' } }),
	)
	expect((await requestPage()).status).toBe(302)

	const page = {
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'digest',
		listing: null,
		ownerPackage: { id: 'pkg-1', name: 'digest', isPrivate: true },
		hasPackage: true,
		viewerIsOwner: false,
		viewerCanManage: false,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
	}
	mockModule.loadPackagePage.mockResolvedValue(page)
	mockModule.loadPackageMappingScopeForViewer.mockResolvedValueOnce(null)
	expect((await requestPage()).status).toBe(404)

	// The mapping scope decides access (package:execute), so execute-only
	// members, who cannot open the package page, still get the page shell.
	for (const access of [
		page,
		{ ...page, viewerIsOwner: true },
		{ kind: 'not_found' },
	]) {
		mockModule.renderAppPage.mockClear()
		mockModule.loadPackagePage.mockResolvedValue(access)
		expect((await requestPage()).status).toBe(200)
		expect(mockModule.renderAppPage).toHaveBeenCalledWith(
			expect.objectContaining({ title: 'Approve credential mappings' }),
		)
	}

	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'redirect',
		to: '/@acme/digest',
		shared: true,
	})
	const moved = await requestPage()
	expect(moved.status).toBe(302)
	expect(moved.headers.get('location')).toBe(
		'https://example.com/@acme/digest/approve-credentials?default%5Bgithub%5D=bot',
	)
})
