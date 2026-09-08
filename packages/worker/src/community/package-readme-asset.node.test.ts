import { expect, test } from 'vitest'
import {
	tinyPngBytes,
	tinyWebpBytes,
} from '#worker/test-support/images-binding.ts'
import {
	buildPackageReadmeAssetHeaders,
	packageReadmeAssetSvgContentSecurityPolicy,
	sniffPackageReadmeImageContentType,
} from './package-readme-asset.ts'
import { packageReadmeImageMaxBytes } from '#universal/package-readme-images.ts'

const tinyGifBytes = Uint8Array.from([
	0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
])
const tinyJpegBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const svgBytes = new TextEncoder().encode(
	'<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
)

test('package README image sniffing requires matching magic bytes and size', () => {
	expect(
		sniffPackageReadmeImageContentType(tinyPngBytes, 'docs/poster.png'),
	).toBe('image/png')
	expect(sniffPackageReadmeImageContentType(tinyJpegBytes, 'shot.jpg')).toBe(
		'image/jpeg',
	)
	expect(sniffPackageReadmeImageContentType(tinyWebpBytes, 'icon.webp')).toBe(
		'image/webp',
	)
	expect(sniffPackageReadmeImageContentType(tinyGifBytes, 'spin.gif')).toBe(
		'image/gif',
	)
	expect(sniffPackageReadmeImageContentType(svgBytes, 'diagram.svg')).toBe(
		'image/svg+xml',
	)
	expect(
		sniffPackageReadmeImageContentType(tinyPngBytes, 'docs/poster.jpg'),
	).toBe(null)
	expect(
		sniffPackageReadmeImageContentType(
			new TextEncoder().encode('console.log(1)'),
			'docs/poster.png',
		),
	).toBe(null)
	expect(
		sniffPackageReadmeImageContentType(
			new TextEncoder().encode('<svg><script>alert(1)</script></svg>'),
			'evil.svg',
		),
	).toBe(null)
	expect(
		sniffPackageReadmeImageContentType(new Uint8Array(0), 'empty.png'),
	).toBe(null)
	expect(
		sniffPackageReadmeImageContentType(
			new Uint8Array(packageReadmeImageMaxBytes + 1),
			'huge.png',
		),
	).toBe(null)

	const headers = buildPackageReadmeAssetHeaders({
		contentType: 'image/svg+xml',
		byteLength: svgBytes.byteLength,
		etag: '"abc:diagram.svg:1"',
		cacheControl: 'public, max-age=3600',
	})
	expect(headers['Content-Security-Policy']).toBe(
		packageReadmeAssetSvgContentSecurityPolicy,
	)
	expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin')
	expect(headers['X-Content-Type-Options']).toBe('nosniff')
})
