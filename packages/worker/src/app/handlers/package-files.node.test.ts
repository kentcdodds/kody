import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
	requireAuthenticatedPageUser: vi.fn<() => Promise<unknown>>(),
	loadCommunityPackageFilesData: vi.fn<() => Promise<unknown>>(),
	loadAccountPackageFilesData: vi.fn<() => Promise<unknown>>(),
	resolveCommunityPackageUrl: vi.fn<() => Promise<unknown>>(),
	renderAppPage: vi.fn<(input: unknown) => Promise<Response>>(
		async () => new Response('ok'),
	),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/package-files-data.ts', () => ({
	loadCommunityPackageFilesData: (...args: Array<unknown>) =>
		mockModule.loadCommunityPackageFilesData(...args),
	loadAccountPackageFilesData: (...args: Array<unknown>) =>
		mockModule.loadAccountPackageFilesData(...args),
	readPackageFilesSelectedPath: (requestUrl: string) => {
		const url = new URL(requestUrl, 'http://localhost')
		const raw = url.searchParams.get('path')
		if (raw == null) return ''
		if (raw.includes('..')) return null
		return raw
	},
}))

vi.mock('#worker/community/package-url.ts', () => ({
	resolveCommunityPackageUrl: (...args: Array<unknown>) =>
		mockModule.resolveCommunityPackageUrl(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) => mockModule.renderAppPage(...args),
}))

const {
	createAccountPackageFilesApiHandler,
	createCommunityPackageFilesApiHandler,
} = await import('./package-files.ts')

const filesPayload = {
	ok: true,
	title: '@owner/demo',
	backHref: '/@owner/demo',
	backLabel: 'Package listing',
	filesBasePath: '/@owner/demo/files',
	selectedPath: 'src/index.ts',
	kind: 'file',
	paths: ['src/index.ts'],
	children: [],
	ancestors: [{ name: 'src', path: 'src' }],
	content: 'export const answer = 42\n',
	contentPath: 'src/index.ts',
	contentKind: 'code',
	language: 'ts',
}

test('community files API resolves the listing, rejects traversal, and 404s misses', async () => {
	const handler = createCommunityPackageFilesApiHandler({} as Env)
	mockModule.resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'listing',
		listingId: 'listing-1',
		username: 'owner',
		kodyId: 'demo',
	})
	mockModule.loadCommunityPackageFilesData.mockResolvedValue(filesPayload)

	const success = await handler.handler({
		request: new Request(
			'https://example.com/profiles/owner/packages/demo/files.json?path=src/index.ts',
		),
		params: { username: 'owner', kodyId: 'demo' },
		url: new URL(
			'https://example.com/profiles/owner/packages/demo/files.json?path=src/index.ts',
		),
	} as never)
	expect(success.status).toBe(200)
	expect(await success.json()).toEqual(filesPayload)
	expect(mockModule.loadCommunityPackageFilesData).toHaveBeenCalledWith({
		env: {},
		listingId: 'listing-1',
		selectedPath: 'src/index.ts',
	})

	const invalid = await handler.handler({
		request: new Request(
			'https://example.com/profiles/owner/packages/demo/files.json?path=../secret',
		),
		params: { username: 'owner', kodyId: 'demo' },
		url: new URL(
			'https://example.com/profiles/owner/packages/demo/files.json?path=../secret',
		),
	} as never)
	expect(invalid.status).toBe(400)

	mockModule.loadCommunityPackageFilesData.mockResolvedValue(null)
	const missing = await handler.handler({
		request: new Request(
			'https://example.com/profiles/owner/packages/demo/files.json',
		),
		params: { username: 'owner', kodyId: 'demo' },
		url: new URL('https://example.com/profiles/owner/packages/demo/files.json'),
	} as never)
	expect(missing.status).toBe(404)
})

test('account files API requires the owner session and does not leak other users', async () => {
	const handler = createAccountPackageFilesApiHandler({} as Env)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await handler.handler({
		request: new Request(
			'https://example.com/account/packages/pkg-1/files.json',
		),
		params: { packageId: 'pkg-1' },
		url: new URL('https://example.com/account/packages/pkg-1/files.json'),
	} as never)
	expect(unauthorized.status).toBe(401)
	expect(mockModule.loadAccountPackageFilesData).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-user-1' },
	})
	mockModule.loadAccountPackageFilesData.mockResolvedValue(filesPayload)
	const success = await handler.handler({
		request: new Request(
			'https://example.com/account/packages/pkg-1/files.json?path=src/index.ts',
		),
		params: { packageId: 'pkg-1' },
		url: new URL(
			'https://example.com/account/packages/pkg-1/files.json?path=src/index.ts',
		),
	} as never)
	expect(success.status).toBe(200)
	expect(mockModule.loadAccountPackageFilesData).toHaveBeenCalledWith({
		env: {},
		request: expect.any(Request),
		userId: 'stable-user-1',
		packageId: 'pkg-1',
		selectedPath: 'src/index.ts',
	})
})
