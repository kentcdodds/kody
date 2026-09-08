import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	loadAccessiblePackageFileRaw: vi.fn<() => Promise<unknown>>(),
	loadCommunityPackageFileRaw: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('#app/package-files-data.ts', () => ({
	loadAccessiblePackageFileRaw: (...args: Array<unknown>) =>
		mockModule.loadAccessiblePackageFileRaw(...args),
	loadCommunityPackageFileRaw: (...args: Array<unknown>) =>
		mockModule.loadCommunityPackageFileRaw(...args),
}))

const { createCommunityDetailRawHandler, createCommunityPackageRawHandler } =
	await import('./package-files-raw.ts')

const pngBytes = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
])

test('raw media serves allowlisted images inline and rejects binaries, HTML, and traversal', async () => {
	const handler = createCommunityPackageRawHandler({} as Env)
	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: pngBytes,
		contentType: 'image/png',
		filename: 'logo.png',
		isPrivate: false,
	})

	const success = await handler.handler({
		request: new Request(
			'https://example.com/@owner/demo/raw/main/docs/logo.png',
		),
		params: {
			username: 'owner',
			kodyId: 'demo',
			ref: 'main',
			relativePath: 'docs/logo.png',
		},
		url: new URL('https://example.com/@owner/demo/raw/main/docs/logo.png'),
	} as never)
	expect(success.status).toBe(200)
	expect(success.headers.get('Content-Type')).toBe('image/png')
	expect(success.headers.get('Content-Disposition')).toBe(
		'inline; filename="logo.png"',
	)
	expect(success.headers.get('X-Content-Type-Options')).toBe('nosniff')
	expect(success.headers.get('Content-Security-Policy')).toContain('sandbox')
	expect(success.headers.get('Content-Security-Policy')).toContain(
		"default-src 'none'",
	)
	expect(await success.arrayBuffer()).toEqual(pngBytes.buffer)

	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'not-media',
	})
	const binary = await handler.handler({
		request: new Request('https://example.com/@owner/demo/raw/main/app.wasm'),
		params: {
			username: 'owner',
			kodyId: 'demo',
			ref: 'main',
			relativePath: 'app.wasm',
		},
		url: new URL('https://example.com/@owner/demo/raw/main/app.wasm'),
	} as never)
	expect(binary.status).toBe(404)
	expect(binary.headers.get('Content-Type')).not.toBe('application/wasm')

	const traversal = await handler.handler({
		request: new Request(
			'https://example.com/@owner/demo/raw/main/../secret.png',
		),
		params: {
			username: 'owner',
			kodyId: 'demo',
			ref: 'main',
			relativePath: '../secret.png',
		},
		url: new URL('https://example.com/@owner/demo/raw/main/../secret.png'),
	} as never)
	expect(traversal.status).toBe(404)
	expect(mockModule.loadAccessiblePackageFileRaw).not.toHaveBeenCalledWith(
		expect.objectContaining({ selectedPath: '../secret.png' }),
	)

	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: new TextEncoder().encode('<html></html>'),
		contentType: 'text/html',
		filename: 'nope.html',
		isPrivate: false,
	})
	const html = await handler.handler({
		request: new Request('https://example.com/@owner/demo/raw/main/nope.html'),
		params: {
			username: 'owner',
			kodyId: 'demo',
			ref: 'main',
			relativePath: 'nope.html',
		},
		url: new URL('https://example.com/@owner/demo/raw/main/nope.html'),
	} as never)
	expect(html.status).toBe(404)
	expect(html.headers.get('Content-Type')).not.toBe('text/html')
})

test('listing raw SVG stays image/svg+xml with sandbox CSP and owner-only files stay private', async () => {
	const handler = createCommunityDetailRawHandler({} as Env)
	const svg = new TextEncoder().encode(
		'<svg xmlns="http://www.w3.org/2000/svg"></svg>',
	)
	mockModule.loadCommunityPackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: svg,
		contentType: 'image/svg+xml',
		filename: 'icon.svg',
		isPrivate: false,
	})
	const publicSvg = await handler.handler({
		request: new Request(
			'https://example.com/community/listing-1/raw/icon.svg',
		),
		params: { listingId: 'listing-1', relativePath: 'icon.svg' },
		url: new URL('https://example.com/community/listing-1/raw/icon.svg'),
	} as never)
	expect(publicSvg.status).toBe(200)
	expect(publicSvg.headers.get('Content-Type')).toBe('image/svg+xml')
	expect(publicSvg.headers.get('Content-Disposition')).toContain('inline')
	expect(publicSvg.headers.get('Content-Security-Policy')).toContain('sandbox')
	expect(publicSvg.headers.get('Cache-Control')).toBe('public, max-age=60')

	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'ok',
		bytes: pngBytes,
		contentType: 'image/png',
		filename: 'logo.png',
		isPrivate: true,
	})
	const privateImage = await createCommunityPackageRawHandler(
		{} as Env,
	).handler({
		request: new Request('https://example.com/@owner/demo/raw/main/logo.png', {
			headers: { Cookie: 'kody_session=abc' },
		}),
		params: {
			username: 'owner',
			kodyId: 'demo',
			ref: 'main',
			relativePath: 'logo.png',
		},
		url: new URL('https://example.com/@owner/demo/raw/main/logo.png'),
	} as never)
	expect(privateImage.status).toBe(200)
	expect(privateImage.headers.get('Cache-Control')).toBe('private, no-store')

	mockModule.loadAccessiblePackageFileRaw.mockResolvedValue({
		kind: 'unauthorized',
	})
	const denied = await createCommunityPackageRawHandler({} as Env).handler({
		request: new Request('https://example.com/@owner/demo/raw/main/logo.png'),
		params: {
			username: 'owner',
			kodyId: 'demo',
			ref: 'main',
			relativePath: 'logo.png',
		},
		url: new URL('https://example.com/@owner/demo/raw/main/logo.png'),
	} as never)
	expect(denied.status).toBe(401)
})
