import { cachified } from '@epic-web/cachified'
import { Resvg } from '@resvg/resvg-wasm'
import { createKvCachifiedCache } from '#worker/kv-cachified.ts'
import { ensureRenderPipelineReady } from '#worker/og/render.ts'
import { readArtifactFileAtCommit } from '#worker/repo/artifact-file.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { getCommunityListingById } from './repo.ts'
import { readCommunitySnapshot } from './snapshot.ts'
import { type CommunityListingRecord } from './types.ts'

const communityIconVersion = 1 as const
const communityIconOutputSize = 256
const maxCommunityIconSourceBytes = 2 * 1024 * 1024
const maxCommunityIconDimension = 4096
const maxCommunityIconPixels = 16_777_216
const maxCommunityIconRenderedBytes = 2 * 1024 * 1024
const communityIconDescriptorTtlMs = 30 * 24 * 60 * 60 * 1000

export const communityIconPaths = [
	'community-icon.svg',
	'community-icon.png',
	'community-icon.webp',
	'community-icon.jpg',
	'community-icon.jpeg',
] as const

type CommunityIconContentType = 'image/png' | 'image/webp' | 'image/jpeg'

type CommunityIconDescriptor = {
	version: typeof communityIconVersion
	listingId: string
	pinnedCommit: string
	r2Key: string
	contentType: CommunityIconContentType
	sourcePath: (typeof communityIconPaths)[number] | null
	byteLength: number
}

type ProcessedCommunityIcon = {
	bytes: Uint8Array
	contentType: CommunityIconContentType
}

export function buildCommunityIconCacheKey(input: {
	listingId: string
	pinnedCommit: string
}) {
	return `community-icon:v${communityIconVersion}:${input.listingId}:${input.pinnedCommit}`
}

export function buildCommunityIconR2Key(input: {
	listingId: string
	pinnedCommit: string
}) {
	return `community-icon:v${communityIconVersion}/${input.listingId}/${input.pinnedCommit}/asset`
}

export function findCommunityIconPath(
	files: Readonly<Record<string, string>>,
): (typeof communityIconPaths)[number] | null {
	return communityIconPaths.find((path) => path in files) ?? null
}

export async function getCommunityIconObject(input: {
	env: Env
	listing: CommunityListingRecord
}): Promise<{
	descriptor: CommunityIconDescriptor
	object: R2ObjectBody
}> {
	const baseCache = createKvCachifiedCache(input.env.BUNDLE_ARTIFACTS_KV)
	const cache = {
		...baseCache,
		async set(key: string, entry: Parameters<typeof baseCache.set>[1]) {
			if (await isCurrentActiveListing(input.env.APP_DB, input.listing)) {
				await baseCache.set(key, entry)
			}
		},
	}
	const key = buildCommunityIconCacheKey({
		listingId: input.listing.id,
		pinnedCommit: input.listing.pinnedCommit,
	})
	const expectedR2Key = buildCommunityIconR2Key({
		listingId: input.listing.id,
		pinnedCommit: input.listing.pinnedCommit,
	})
	const loadDescriptor = (forceFresh = false) =>
		cachified({
			key,
			cache,
			ttl: communityIconDescriptorTtlMs,
			forceFresh,
			checkValue: (value) =>
				isCommunityIconDescriptor(value) &&
				value.listingId === input.listing.id &&
				value.pinnedCommit === input.listing.pinnedCommit &&
				value.r2Key === expectedR2Key,
			getFreshValue: () => createCommunityIconDescriptor(input),
		})

	let descriptor = await loadDescriptor()
	let object = await input.env.COMMUNITY_ASSETS.get(descriptor.r2Key)
	if (!object) {
		await cache.delete(key)
		descriptor = await loadDescriptor(true)
		object = await input.env.COMMUNITY_ASSETS.get(descriptor.r2Key)
	}
	if (!object) {
		throw new Error(
			`Community icon object "${descriptor.r2Key}" was not available after regeneration.`,
		)
	}
	return { descriptor, object }
}

export async function deleteCommunityIconAsset(input: {
	env: Pick<Env, 'BUNDLE_ARTIFACTS_KV' | 'COMMUNITY_ASSETS'>
	listingId: string
	pinnedCommit: string
}) {
	const cache = createKvCachifiedCache(input.env.BUNDLE_ARTIFACTS_KV)
	await Promise.all([
		cache.delete(buildCommunityIconCacheKey(input)),
		input.env.COMMUNITY_ASSETS.delete(buildCommunityIconR2Key(input)),
	])
}

async function createCommunityIconDescriptor(input: {
	env: Env
	listing: CommunityListingRecord
}): Promise<CommunityIconDescriptor> {
	const snapshot = await readCommunitySnapshot(
		input.env.BUNDLE_ARTIFACTS_KV,
		input.listing.id,
	)
	if (!snapshot || snapshot.pinnedCommit !== input.listing.pinnedCommit) {
		throw new Error(
			`Community listing snapshot for "${input.listing.id}" at "${input.listing.pinnedCommit}" was not found.`,
		)
	}

	const sourcePath =
		communityIconPaths.find((path) => path === snapshot.communityIconPath) ??
		findCommunityIconPath(snapshot.files)
	let processed: ProcessedCommunityIcon
	if (sourcePath === 'community-icon.svg') {
		const source = snapshot.files[sourcePath]
		if (source == null) {
			throw new Error(
				`Community icon "${sourcePath}" was not retained in the listing snapshot.`,
			)
		}
		processed = await processCommunityIcon({
			path: sourcePath,
			sourceBytes: new TextEncoder().encode(source),
		})
	} else if (sourcePath) {
		const source = await getEntitySourceById(
			input.env.APP_DB,
			input.listing.sourceId,
		)
		if (
			!source ||
			source.user_id !== input.listing.ownerUserId ||
			source.entity_kind !== 'package' ||
			source.entity_id !== input.listing.packageId
		) {
			throw new Error(
				`Community listing "${input.listing.id}" has an invalid package source.`,
			)
		}
		const sourceBytes = await readArtifactFileAtCommit({
			env: input.env,
			repoId: source.repo_id,
			commit: input.listing.pinnedCommit,
			filePath: sourcePath,
		})
		if (!sourceBytes) {
			throw new Error(
				`Community icon "${sourcePath}" was not found at pinned commit "${input.listing.pinnedCommit}".`,
			)
		}
		processed = await processCommunityIcon({ path: sourcePath, sourceBytes })
	} else {
		processed = {
			bytes: await renderCommunitySvgIcon(
				buildCommunityIconFallbackSvg(input.listing.name),
			),
			contentType: 'image/png',
		}
	}

	const r2Key = buildCommunityIconR2Key({
		listingId: input.listing.id,
		pinnedCommit: input.listing.pinnedCommit,
	})
	await input.env.COMMUNITY_ASSETS.put(r2Key, processed.bytes, {
		httpMetadata: {
			contentType: processed.contentType,
			cacheControl: 'public, max-age=3600',
		},
		customMetadata: {
			listingId: input.listing.id,
			pinnedCommit: input.listing.pinnedCommit,
			sourcePath: sourcePath ?? '',
		},
	})
	if (!(await isCurrentActiveListing(input.env.APP_DB, input.listing))) {
		await input.env.COMMUNITY_ASSETS.delete(r2Key)
		throw new Error(
			`Community listing "${input.listing.id}" was removed while its icon was generated.`,
		)
	}
	return {
		version: communityIconVersion,
		listingId: input.listing.id,
		pinnedCommit: input.listing.pinnedCommit,
		r2Key,
		contentType: processed.contentType,
		sourcePath,
		byteLength: processed.bytes.byteLength,
	}
}

async function isCurrentActiveListing(
	db: D1Database,
	listing: CommunityListingRecord,
) {
	const current = await getCommunityListingById(db, {
		listingId: listing.id,
		includeDelisted: false,
	})
	return (
		current?.ownerUserId === listing.ownerUserId &&
		current.packageId === listing.packageId &&
		current.sourceId === listing.sourceId &&
		current.pinnedCommit === listing.pinnedCommit
	)
}

export async function processCommunityIcon(input: {
	path: (typeof communityIconPaths)[number]
	sourceBytes: Uint8Array
}): Promise<ProcessedCommunityIcon> {
	assertCommunityIconSourceSize(input.sourceBytes)
	if (input.path.endsWith('.svg')) {
		const source = decodeSvg(input.sourceBytes)
		assertSafeCommunitySvg(source)
		const bytes = await renderCommunitySvgIcon(source)
		return { bytes, contentType: 'image/png' }
	}

	const dimensions = readRasterDimensions(input.path, input.sourceBytes)
	assertCommunityIconDimensions(dimensions)
	if (input.path.endsWith('.png')) {
		return { bytes: input.sourceBytes, contentType: 'image/png' }
	}
	if (input.path.endsWith('.webp')) {
		return { bytes: input.sourceBytes, contentType: 'image/webp' }
	}
	return { bytes: input.sourceBytes, contentType: 'image/jpeg' }
}

function assertCommunityIconSourceSize(bytes: Uint8Array) {
	if (
		bytes.byteLength === 0 ||
		bytes.byteLength > maxCommunityIconSourceBytes
	) {
		throw new Error(
			`Community icons must be between 1 byte and ${maxCommunityIconSourceBytes} bytes.`,
		)
	}
}

function decodeSvg(bytes: Uint8Array) {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw new Error('Community SVG icons must be valid UTF-8.')
	}
}

function assertSafeCommunitySvg(source: string) {
	if (!/<svg(?:\s|>)/i.test(source)) {
		throw new Error('Community SVG icons must contain an <svg> root element.')
	}
	if (
		/<(?:script|foreignObject|iframe|object|embed)\b/i.test(source) ||
		/<!DOCTYPE|<!ENTITY/i.test(source) ||
		/\b(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|file:|javascript:|data:text\/html)/i.test(
			source,
		) ||
		/url\(\s*["']?(?:https?:|\/\/|file:|javascript:)/i.test(source)
	) {
		throw new Error(
			'Community SVG icons cannot contain active external content.',
		)
	}
}

async function renderCommunitySvgIcon(source: string) {
	await ensureRenderPipelineReady()
	const resvg = new Resvg(source, {
		fitTo: { mode: 'width', value: communityIconOutputSize },
	})
	const rendered = resvg.render()
	try {
		const width = rendered.width
		const height = rendered.height
		assertCommunityIconDimensions({ width, height })
		const png = rendered.asPng()
		if (png.byteLength > maxCommunityIconRenderedBytes) {
			throw new Error(
				`Rendered community icons must not exceed ${maxCommunityIconRenderedBytes} bytes.`,
			)
		}
		return png
	} finally {
		rendered.free()
		resvg.free()
	}
}

function readRasterDimensions(
	path: (typeof communityIconPaths)[number],
	bytes: Uint8Array,
) {
	if (path.endsWith('.png')) return readPngDimensions(bytes)
	if (path.endsWith('.webp')) return readWebpDimensions(bytes)
	return readJpegDimensions(bytes)
}

function readPngDimensions(bytes: Uint8Array) {
	const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
	if (
		bytes.byteLength < 24 ||
		!signature.every((byte, index) => bytes[index] === byte) ||
		readAscii(bytes, 12, 4) !== 'IHDR'
	) {
		throw new Error('Community PNG icons must contain a valid PNG header.')
	}
	return {
		width: readUint32BigEndian(bytes, 16),
		height: readUint32BigEndian(bytes, 20),
	}
}

function readJpegDimensions(bytes: Uint8Array) {
	if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		throw new Error('Community JPEG icons must contain a valid JPEG header.')
	}
	const frameMarkers = new Set([
		0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
		0xcf,
	])
	let offset = 2
	while (offset + 3 < bytes.byteLength) {
		while (bytes[offset] === 0xff) offset++
		const marker = bytes[offset]
		offset++
		if (marker == null || marker === 0xd9 || marker === 0xda) break
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
		const segmentLength = readUint16BigEndian(bytes, offset)
		if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) break
		if (frameMarkers.has(marker)) {
			if (segmentLength < 7) break
			return {
				height: readUint16BigEndian(bytes, offset + 3),
				width: readUint16BigEndian(bytes, offset + 5),
			}
		}
		offset += segmentLength
	}
	throw new Error('Community JPEG icons must contain valid image dimensions.')
}

function readWebpDimensions(bytes: Uint8Array) {
	if (
		bytes.byteLength < 30 ||
		readAscii(bytes, 0, 4) !== 'RIFF' ||
		readAscii(bytes, 8, 4) !== 'WEBP'
	) {
		throw new Error('Community WebP icons must contain a valid WebP header.')
	}
	const chunk = readAscii(bytes, 12, 4)
	switch (chunk) {
		case 'VP8X':
			return {
				width: 1 + readUint24LittleEndian(bytes, 24),
				height: 1 + readUint24LittleEndian(bytes, 27),
			}
		case 'VP8L':
			if (bytes[20] !== 0x2f) break
			return {
				width: 1 + (bytes[21] ?? 0) + (((bytes[22] ?? 0) & 0x3f) << 8),
				height:
					1 +
					((bytes[22] ?? 0) >> 6) +
					((bytes[23] ?? 0) << 2) +
					(((bytes[24] ?? 0) & 0x0f) << 10),
			}
		case 'VP8 ':
			if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
				break
			}
			return {
				width: readUint16LittleEndian(bytes, 26) & 0x3fff,
				height: readUint16LittleEndian(bytes, 28) & 0x3fff,
			}
		default: {
			const unreachable: string = chunk
			throw new Error(
				`Community WebP icons use an unsupported "${unreachable}" chunk.`,
			)
		}
	}
	throw new Error('Community WebP icons must contain valid image dimensions.')
}

function assertCommunityIconDimensions(dimensions: {
	width: number
	height: number
}) {
	if (
		!Number.isInteger(dimensions.width) ||
		!Number.isInteger(dimensions.height) ||
		dimensions.width < 1 ||
		dimensions.height < 1 ||
		dimensions.width > maxCommunityIconDimension ||
		dimensions.height > maxCommunityIconDimension ||
		dimensions.width * dimensions.height > maxCommunityIconPixels
	) {
		throw new Error(
			`Community icons must be at most ${maxCommunityIconDimension}px per side and ${maxCommunityIconPixels} total pixels.`,
		)
	}
}

function readAscii(bytes: Uint8Array, offset: number, length: number) {
	return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function readUint16BigEndian(bytes: Uint8Array, offset: number) {
	return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0)
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number) {
	return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)
}

function readUint24LittleEndian(bytes: Uint8Array, offset: number) {
	return (
		(bytes[offset] ?? 0) |
		((bytes[offset + 1] ?? 0) << 8) |
		((bytes[offset + 2] ?? 0) << 16)
	)
}

function readUint32BigEndian(bytes: Uint8Array, offset: number) {
	return (
		(((bytes[offset] ?? 0) << 24) |
			((bytes[offset + 1] ?? 0) << 16) |
			((bytes[offset + 2] ?? 0) << 8) |
			(bytes[offset + 3] ?? 0)) >>>
		0
	)
}

export function buildCommunityIconFallbackSvg(name: string) {
	const words = name
		.replace(/^@[^/]+\//, '')
		.split(/[^a-z0-9]+/i)
		.filter(Boolean)
	const initials =
		(words.length > 1
			? `${words[0]?.[0]}${words[1]?.[0]}`
			: words[0]?.slice(0, 2)
		)
			?.toUpperCase()
			.replace(/[^A-Z0-9]/g, '') || 'K'
	const colors = [
		'#2563eb',
		'#7c3aed',
		'#db2777',
		'#0891b2',
		'#059669',
	] as const
	let hash = 0
	for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) | 0
	const background = colors[Math.abs(hash) % colors.length]
	return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="56" fill="${background}"/><text x="128" y="136" fill="white" font-family="sans-serif" font-size="92" font-weight="700" text-anchor="middle" dominant-baseline="middle">${initials}</text></svg>`
}

export async function renderCommunityIconFallbackPng(name: string) {
	return await renderCommunitySvgIcon(buildCommunityIconFallbackSvg(name))
}

function isCommunityIconDescriptor(
	value: unknown,
): value is CommunityIconDescriptor {
	if (!value || typeof value !== 'object') return false
	const descriptor = value as Partial<CommunityIconDescriptor>
	return (
		descriptor.version === communityIconVersion &&
		typeof descriptor.listingId === 'string' &&
		typeof descriptor.pinnedCommit === 'string' &&
		typeof descriptor.r2Key === 'string' &&
		['image/png', 'image/webp', 'image/jpeg'].includes(
			descriptor.contentType ?? '',
		) &&
		(descriptor.sourcePath === null ||
			communityIconPaths.some((path) => path === descriptor.sourcePath)) &&
		typeof descriptor.byteLength === 'number'
	)
}
