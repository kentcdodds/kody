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
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Parameters<typeof SsrRender.renderAppPage>) =>
		mockModule.renderAppPage(...args),
}))

vi.mock('#app/frame-registrations.ts', () => ({}))
vi.mock('#app/frame-registry.ts', () => ({
	handleFrameRequest: async () => null,
}))

const { createCommunityPackageSettingsHandler } =
	await import('./community-detail.tsx')

test('package settings 404 unless the viewer owns the package', async () => {
	const handler = createCommunityPackageSettingsHandler({} as Env)
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		listing: null,
		ownerPackage: { id: 'pkg-1', name: 'friction-log', isPrivate: true },
		viewerIsOwner: false,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
	})

	const stranger = await handler.handler({
		request: new Request(
			'https://example.com/@kentcdodds/friction-log/settings',
		),
		params: { username: 'kentcdodds', kodyId: 'friction-log' },
		url: new URL('https://example.com/@kentcdodds/friction-log/settings'),
	} as never)
	expect(mockModule.renderAppPage).toHaveBeenCalledWith(
		expect.objectContaining({ notFound: true, status: 404 }),
	)
	expect(stranger.status).toBe(404)

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
