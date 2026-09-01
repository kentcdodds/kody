import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<() => Promise<unknown>>(),
	requireAuthenticatedPageUser: vi.fn<() => Promise<unknown>>(),
	loadCommunityPackageFilesData: vi.fn<() => Promise<unknown>>(),
	loadAccountPackageFilesData: vi.fn<() => Promise<unknown>>(),
	loadAccessiblePackageFilesData: vi.fn<() => Promise<unknown>>(),
	loadPackagePage: vi.fn<() => Promise<unknown>>(),
	getSavedPackageById: vi.fn<() => Promise<unknown>>(),
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

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Array<unknown>) =>
		mockModule.loadPackagePage(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#app/package-files-data.ts', () => ({
	loadCommunityPackageFilesData: (...args: Array<unknown>) =>
		mockModule.loadCommunityPackageFilesData(...args),
	loadAccountPackageFilesData: (...args: Array<unknown>) =>
		mockModule.loadAccountPackageFilesData(...args),
	loadAccessiblePackageFilesData: (...args: Array<unknown>) =>
		mockModule.loadAccessiblePackageFilesData(...args),
	readPackageFilesSelectedPath: (requestUrl: string) => {
		const url = new URL(requestUrl, 'http://localhost')
		const raw = url.searchParams.get('path')
		if (raw == null) return ''
		if (raw.includes('..')) return null
		return raw
	},
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: (...args: Array<unknown>) => mockModule.renderAppPage(...args),
}))

const {
	createAccountPackageFilesApiHandler,
	createAccountPackageFilesHandler,
	createCommunityPackageFilesApiHandler,
} = await import('./package-files.ts')

const filesPayload = {
	ok: true,
	title: '@owner/demo',
	backHref: '/@owner/demo',
	backLabel: 'Code',
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

test('community files API resolves the package page and rejects traversal', async () => {
	const handler = createCommunityPackageFilesApiHandler({} as Env)
	mockModule.loadPackagePage.mockResolvedValue({
		kind: 'page',
		username: 'owner',
		kodyId: 'demo',
		listing: { listing: { id: 'listing-1' } },
		viewerIsOwner: false,
	})
	mockModule.loadAccessiblePackageFilesData.mockResolvedValue(filesPayload)

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
	expect(mockModule.loadAccessiblePackageFilesData).toHaveBeenCalledWith({
		env: {},
		request: expect.any(Request),
		username: 'owner',
		kodyId: 'demo',
		selectedPath: 'src/index.ts',
		ref: '',
		serverTiming: expect.any(Array),
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

	mockModule.loadAccessiblePackageFilesData.mockResolvedValue(null)
	const missing = await handler.handler({
		request: new Request(
			'https://example.com/profiles/owner/packages/demo/files.json',
		),
		params: { username: 'owner', kodyId: 'demo' },
		url: new URL('https://example.com/profiles/owner/packages/demo/files.json'),
	} as never)
	expect(missing.status).toBe(404)
})

test('account files HTML and JSON redirect to the package tree', async () => {
	const htmlHandler = createAccountPackageFilesHandler({} as Env)
	const apiHandler = createAccountPackageFilesApiHandler({} as Env)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const unauthorized = await apiHandler.handler({
		request: new Request(
			'https://example.com/account/packages/pkg-1/files.json',
		),
		params: { packageId: 'pkg-1' },
		url: new URL('https://example.com/account/packages/pkg-1/files.json'),
	} as never)
	expect(unauthorized.status).toBe(401)
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: 'stable-user-1' },
		username: 'owner',
	})
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		mcpUser: { userId: 'stable-user-1' },
		username: 'owner',
	})
	mockModule.getSavedPackageById.mockResolvedValue({
		kodyId: 'demo',
	})

	const json = await apiHandler.handler({
		request: new Request(
			'https://example.com/account/packages/pkg-1/files.json?path=src/index.ts',
		),
		params: { packageId: 'pkg-1' },
		url: new URL(
			'https://example.com/account/packages/pkg-1/files.json?path=src/index.ts',
		),
	} as never)
	expect(json.status).toBe(404)
	expect(await json.json()).toEqual({
		ok: false,
		error: 'Package files moved.',
		redirectTo: '/@owner/demo/tree/main/src/index.ts',
	})
	expect(mockModule.loadAccountPackageFilesData).not.toHaveBeenCalled()

	const html = await htmlHandler.handler({
		request: new Request('https://example.com/account/packages/pkg-1/files'),
		params: { packageId: 'pkg-1' },
		url: new URL('https://example.com/account/packages/pkg-1/files'),
	} as never)
	expect(html.status).toBe(302)
	expect(html.headers.get('location')).toBe(
		'https://example.com/@owner/demo/tree/main',
	)
})
