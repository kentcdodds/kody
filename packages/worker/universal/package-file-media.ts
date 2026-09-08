/**
 * Allowlisted media / binary detection for the package files explorer.
 *
 * Raster and video bytes are served on a same-origin `/raw/` route and
 * previewed with `<img>` / `<video>` / `<audio>`. SVG is XSS-sensitive: we
 * never inject markup into the DOM. A `.svg` that looks like SVG is previewed
 * only as `<img src="…/raw/…">` (scripts do not run in `<img>`). Anything that
 * looks like HTML stays source/code.
 *
 * Classification requires an allowlisted extension. The raw route also sniffs
 * magic bytes (or the SVG text shape) before setting a media Content-Type —
 * filename alone is not enough to serve bytes as renderable media.
 */

type PackageFilesTextKind = 'markdown' | 'code' | 'text'
export type PackageFilesMediaKind = 'image' | 'video' | 'audio'
export type PackageFilesContentKind =
	| PackageFilesTextKind
	| PackageFilesMediaKind
	| 'binary'

export const maxPackageFilePreviewBytes = 10 * 1024 * 1024

type MediaType = {
	kind: PackageFilesMediaKind
	contentType: string
}

const mediaTypesByExtension: Record<string, MediaType> = {
	png: { kind: 'image', contentType: 'image/png' },
	jpg: { kind: 'image', contentType: 'image/jpeg' },
	jpeg: { kind: 'image', contentType: 'image/jpeg' },
	gif: { kind: 'image', contentType: 'image/gif' },
	webp: { kind: 'image', contentType: 'image/webp' },
	avif: { kind: 'image', contentType: 'image/avif' },
	svg: { kind: 'image', contentType: 'image/svg+xml' },
	mp4: { kind: 'video', contentType: 'video/mp4' },
	webm: { kind: 'video', contentType: 'video/webm' },
	ogv: { kind: 'video', contentType: 'video/ogg' },
	mp3: { kind: 'audio', contentType: 'audio/mpeg' },
	wav: { kind: 'audio', contentType: 'audio/wav' },
	ogg: { kind: 'audio', contentType: 'audio/ogg' },
	oga: { kind: 'audio', contentType: 'audio/ogg' },
}

const binaryExtensions = new Set([
	'7z',
	'a',
	'apk',
	'bin',
	'bz2',
	'class',
	'db',
	'dll',
	'dmg',
	'dylib',
	'eot',
	'exe',
	'gz',
	'ico',
	'iso',
	'lib',
	'o',
	'obj',
	'otf',
	'parquet',
	'pdf',
	'pyc',
	'rar',
	'so',
	'sqlite',
	'tar',
	'tgz',
	'ttf',
	'wasm',
	'woff',
	'woff2',
	'xz',
	'zip',
])

function packageFileExtension(path: string) {
	const name = path.split('/').pop() ?? ''
	const separator = name.lastIndexOf('.')
	if (separator <= 0) return ''
	return name.slice(separator + 1).toLowerCase()
}

export function packageFileBaseName(path: string) {
	return path.split('/').pop() || path
}

export function isPackageFilesMediaKind(
	kind: string | null | undefined,
): kind is PackageFilesMediaKind {
	return kind === 'image' || kind === 'video' || kind === 'audio'
}

function allowlistedPackageFileMedia(path: string): MediaType | undefined {
	return mediaTypesByExtension[packageFileExtension(path)]
}

/**
 * Raster / video / unknown-binary snapshots stay latin1 so a later preview
 * can recover the original bytes. SVG is text (UTF-8).
 */
export function shouldStoreArtifactBlobAsLatin1(path: string) {
	const extension = packageFileExtension(path)
	if (extension === 'svg') return false
	return (
		Object.hasOwn(mediaTypesByExtension, extension) ||
		binaryExtensions.has(extension)
	)
}

export function latin1StringToBytes(value: string) {
	const bytes = new Uint8Array(value.length)
	for (let index = 0; index < value.length; index += 1) {
		bytes[index] = value.charCodeAt(index) & 0xff
	}
	return bytes
}

/**
 * Byte-for-byte string encoding. Do not use `TextDecoder('latin1')` — the
 * Encoding spec maps that label to windows-1252, which remaps 0x80–0x9F
 * (PNG's leading 0x89 becomes U+2030).
 */
export function bytesToLatin1String(bytes: Uint8Array) {
	const chunkSize = 0x8000
	let result = ''
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		result += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
	}
	return result
}

export function snapshotStringToBytes(content: string, path: string) {
	if (content.includes('\0') || shouldStoreArtifactBlobAsLatin1(path)) {
		return latin1StringToBytes(content)
	}
	return new TextEncoder().encode(content)
}

function measurePackageFileBytes(path: string, content: string) {
	return snapshotStringToBytes(content, path).byteLength
}

/**
 * SVG preview is `<img src>` only. Reject HTML/script documents so they stay
 * in the source view instead of being served as `image/svg+xml`.
 */
export function looksLikeSvg(content: string) {
	const trimmed = content.replace(/^\uFEFF/, '').trimStart()
	if (
		/^<(?:!DOCTYPE\s+html|html|head|body|script|iframe|object|embed)\b/i.test(
			trimmed,
		)
	) {
		return false
	}
	if (/^<svg[\s>/]/i.test(trimmed)) return true
	return (
		/^<\?xml\b/i.test(trimmed) && /<svg[\s>/]/i.test(trimmed.slice(0, 2048))
	)
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
	if (bytes.byteLength < offset + length) return ''
	return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function startsWithBytes(
	bytes: Uint8Array,
	expected: ReadonlyArray<number>,
	offset = 0,
) {
	if (bytes.byteLength < offset + expected.length) return false
	return expected.every((value, index) => bytes[offset + index] === value)
}

function hasFtypBrand(bytes: Uint8Array, brands?: ReadonlyArray<string>) {
	if (readAscii(bytes, 4, 4) !== 'ftyp') return false
	if (!brands || brands.length === 0) return true
	const major = readAscii(bytes, 8, 4)
	if (brands.includes(major)) return true
	for (
		let offset = 16;
		offset + 4 <= Math.min(bytes.byteLength, 256);
		offset += 4
	) {
		if (brands.includes(readAscii(bytes, offset, 4))) return true
	}
	return false
}

function matchesMediaMagic(bytes: Uint8Array, contentType: string) {
	switch (contentType) {
		case 'image/png':
			return startsWithBytes(
				bytes,
				[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			)
		case 'image/jpeg':
			return startsWithBytes(bytes, [0xff, 0xd8, 0xff])
		case 'image/gif':
			return (
				startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
				startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
			)
		case 'image/webp':
			return (
				startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
				startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
			)
		case 'image/avif':
			return hasFtypBrand(bytes, ['avif', 'avis'])
		case 'video/mp4':
			return hasFtypBrand(bytes)
		case 'video/webm':
			return startsWithBytes(bytes, [0x1a, 0x45, 0xdf, 0xa3])
		case 'video/ogg':
		case 'audio/ogg':
			return startsWithBytes(bytes, [0x4f, 0x67, 0x67, 0x53])
		case 'audio/mpeg':
			return (
				startsWithBytes(bytes, [0x49, 0x44, 0x33]) ||
				(bytes[0] === 0xff && bytes.length > 1 && (bytes[1]! & 0xe0) === 0xe0)
			)
		case 'audio/wav':
			return (
				startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) &&
				startsWithBytes(bytes, [0x57, 0x41, 0x56, 0x45], 8)
			)
		case 'image/svg+xml':
			return looksLikeSvg(new TextDecoder().decode(bytes))
		default:
			return false
	}
}

export function sniffPackageFileMedia(input: {
	path: string
	bytes: Uint8Array
}): MediaType | null {
	const media = allowlistedPackageFileMedia(input.path)
	if (!media) return null
	if (input.bytes.byteLength > maxPackageFilePreviewBytes) return null
	if (!matchesMediaMagic(input.bytes, media.contentType)) return null
	return media
}

/**
 * Explorer classification. Allowlisted media becomes a preview kind (content
 * is omitted from the page payload). Known binaries and NUL blobs become
 * `binary` so they are never dumped as code. SVG must look like SVG or it
 * falls through to the XML/source view.
 */
export function classifyPackageFileMedia(input: {
	path: string
	content: string
}): {
	kind: PackageFilesMediaKind | 'binary'
	contentType: string | null
	byteLength: number
} | null {
	const media = allowlistedPackageFileMedia(input.path)
	const byteLength = measurePackageFileBytes(input.path, input.content)
	if (media) {
		if (byteLength > maxPackageFilePreviewBytes) {
			return { kind: 'binary', contentType: null, byteLength }
		}
		if (media.contentType === 'image/svg+xml') {
			if (!looksLikeSvg(input.content)) return null
			return { kind: 'image', contentType: media.contentType, byteLength }
		}
		return {
			kind: media.kind,
			contentType: media.contentType,
			byteLength,
		}
	}
	if (
		binaryExtensions.has(packageFileExtension(input.path)) ||
		input.content.includes('\0')
	) {
		return { kind: 'binary', contentType: null, byteLength }
	}
	return null
}

export function packageFileKindLabel(
	path: string | null | undefined,
	contentKind: PackageFilesContentKind | null | undefined,
) {
	if (contentKind === 'binary') return 'Binary'
	if (isPackageFilesMediaKind(contentKind) && path) {
		const extension = packageFileExtension(path)
		return extension ? extension.toUpperCase() : 'Media'
	}
	return ''
}

export function safeContentDispositionFilename(path: string) {
	const name = packageFileBaseName(path).replace(/["\\\r\n]/g, '_')
	return name || 'file'
}
