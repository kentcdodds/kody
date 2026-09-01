import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	loadPackagePage: vi.fn<() => Promise<unknown>>(),
	renderAppPage: vi.fn<(input: unknown) => Promise<Response>>(
		async (input) =>
			new Response('ok', {
				status: (input as { status?: number }).status ?? 200,
			}),
	),
}))

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Array<unknown>) =>
		mockModule.loadPackagePage(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) => mockModule.renderAppPage(...args),
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
				}),
			}),
		}),
	)
})
