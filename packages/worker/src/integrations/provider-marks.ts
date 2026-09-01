import { toHex } from '@kody-internal/shared/hex.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { routes } from '#universal/routes.ts'
import {
	processPlatformOauthAppLogo,
	servedLogoFromObject,
	type PlatformOauthAppLogoContentType,
	type ServedFittedLogo,
} from './platform-app-logo.ts'

const providerMarkLogoR2KeyPrefix = 'platform-provider-marks/'
const providerMarkLogoCacheControl = 'public, max-age=31536000, immutable'

export type PlatformProviderMark = {
	slug: string
	label: string
	aliases: Array<string>
	logoKey: string | null
	logoContentType: string | null
	createdAt: string
	updatedAt: string
}

type ProviderMarkRow = {
	slug: string
	label: string
	aliases_json: string
	logo_key: string | null
	logo_content_type: string | null
	created_at: string
	updated_at: string
}

export class PlatformProviderMarkValidationError extends Error {
	override name = 'PlatformProviderMarkValidationError'
}

function extensionForContentType(contentType: PlatformOauthAppLogoContentType) {
	switch (contentType) {
		case 'image/png':
			return 'png'
		case 'image/jpeg':
			return 'jpg'
		case 'image/webp':
			return 'webp'
		default: {
			const unreachable: never = contentType
			throw new Error(`Unsupported mark content type: ${unreachable}`)
		}
	}
}

async function sha256Hex(bytes: Uint8Array) {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	const digest = await crypto.subtle.digest('SHA-256', copy)
	return toHex(new Uint8Array(digest))
}

export function parseProviderMarkAliases(raw: string): Array<string> {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return []
	}
	if (!Array.isArray(parsed)) return []
	return normalizeProviderMarkAliases(
		parsed.filter((value): value is string => typeof value === 'string'),
	)
}

export function normalizeProviderMarkAliases(
	aliases: ReadonlyArray<string>,
): Array<string> {
	return Array.from(
		new Set(
			aliases
				.map((alias) => alias.trim().toLowerCase())
				.filter((alias) => alias.length > 0),
		),
	).sort()
}

export function hostFromProviderUrl(
	raw: string | null | undefined,
): string | null {
	if (!raw?.trim()) return null
	try {
		return new URL(raw).hostname.toLowerCase() || null
	} catch {
		return null
	}
}

function mapProviderMarkRow(row: ProviderMarkRow): PlatformProviderMark {
	return {
		slug: row.slug,
		label: row.label,
		aliases: parseProviderMarkAliases(row.aliases_json),
		logoKey: row.logo_key,
		logoContentType: row.logo_content_type,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

/**
 * Relative serving path for an operator-curated provider mark. The `v`
 * parameter carries the content hash from the R2 key so the immutable cache
 * busts on upload.
 */
export function buildProviderMarkLogoPath(mark: {
	slug: string
	logoKey: string | null
}): string | null {
	if (!mark.logoKey) return null
	const contentTag = /\/([0-9a-f]{16})[^/]*$/.exec(mark.logoKey)?.[1]
	return routes.providerMarkLogo.href(
		{ slug: mark.slug },
		contentTag ? { searchParams: { v: contentTag } } : undefined,
	)
}

export function providerMarkMatches(input: {
	mark: Pick<PlatformProviderMark, 'slug' | 'aliases'>
	providerKey?: string | null
	host?: string | null
}): boolean {
	const key = input.providerKey?.trim().toLowerCase() ?? ''
	const slug = input.mark.slug
	if (key) {
		if (key === slug) return true
		if (input.mark.aliases.includes(key)) return true
		if (slug === 'x') {
			if (key.startsWith('x-')) return true
		} else if (key.startsWith(`${slug}-`) || key.endsWith(`-${slug}`)) {
			return true
		}
	}
	const host = input.host?.trim().toLowerCase() ?? ''
	if (!host) return false
	for (const alias of input.mark.aliases) {
		if (host === alias || host.endsWith(`.${alias}`)) return true
	}
	return false
}

/**
 * Prefer an exact slug, then an alias key, then the longest family match,
 * then a host alias. Marks without a stored logo never win.
 */
export function resolveProviderMark(input: {
	marks: ReadonlyArray<PlatformProviderMark>
	providerKey?: string | null
	host?: string | null
}): PlatformProviderMark | null {
	const withLogo = input.marks.filter((mark) => mark.logoKey)
	if (withLogo.length === 0) return null
	const key = input.providerKey?.trim().toLowerCase() ?? ''
	if (key) {
		const exact = withLogo.find((mark) => mark.slug === key)
		if (exact) return exact
		const aliasExact = withLogo.find((mark) => mark.aliases.includes(key))
		if (aliasExact) return aliasExact
		const family = withLogo
			.filter((mark) =>
				providerMarkMatches({
					mark,
					providerKey: key,
				}),
			)
			.sort((left, right) => right.slug.length - left.slug.length)
		if (family[0]) return family[0]
	}
	if (!input.host?.trim()) return null
	return (
		withLogo.find((mark) =>
			providerMarkMatches({
				mark,
				host: input.host,
			}),
		) ?? null
	)
}

export function resolveProviderMarkLogoPath(input: {
	marks: ReadonlyArray<PlatformProviderMark>
	providerKey?: string | null
	host?: string | null
}): string | null {
	const mark = resolveProviderMark(input)
	return mark ? buildProviderMarkLogoPath(mark) : null
}

export function attachCatalogLogoPath<
	T extends {
		provider?: string | null
		slug?: string
		name?: string
		authorization?: { authorizeUrl?: string | null } | null
		authorizeUrl?: string | null
		tokenUrl?: string
		catalogLogoPath?: string | null
	},
>(record: T, marks: ReadonlyArray<PlatformProviderMark>): T {
	return {
		...record,
		catalogLogoPath: resolveProviderMarkLogoPath({
			marks,
			providerKey: record.provider ?? record.slug ?? record.name,
			host: hostFromProviderUrl(
				record.authorization?.authorizeUrl ??
					record.authorizeUrl ??
					record.tokenUrl,
			),
		}),
	}
}

export async function listPlatformProviderMarks(input: {
	db: D1Database
}): Promise<Array<PlatformProviderMark>> {
	const result = await input.db
		.prepare(
			`SELECT slug, label, aliases_json, logo_key, logo_content_type,
				created_at, updated_at
			FROM platform_provider_marks
			ORDER BY slug`,
		)
		.all<ProviderMarkRow>()
	return (result.results ?? []).map(mapProviderMarkRow)
}

export async function getPlatformProviderMarkBySlug(input: {
	db: D1Database
	slug: string
}): Promise<PlatformProviderMark | null> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return null
	const row = await input.db
		.prepare(
			`SELECT slug, label, aliases_json, logo_key, logo_content_type,
				created_at, updated_at
			FROM platform_provider_marks
			WHERE slug = ?`,
		)
		.bind(slug)
		.first<ProviderMarkRow>()
	return row ? mapProviderMarkRow(row) : null
}

export async function upsertPlatformProviderMark(input: {
	db: D1Database
	slug: string
	label?: string | null
	aliases?: ReadonlyArray<string>
}): Promise<PlatformProviderMark> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) {
		throw new PlatformProviderMarkValidationError(
			'Slug must contain letters or numbers.',
		)
	}
	const existing = await getPlatformProviderMarkBySlug({
		db: input.db,
		slug,
	})
	const now = new Date().toISOString()
	const label =
		input.label === undefined
			? (existing?.label ?? slug)
			: input.label?.trim() || slug
	const aliasesJson = JSON.stringify(
		input.aliases === undefined
			? (existing?.aliases ?? [])
			: normalizeProviderMarkAliases(input.aliases),
	)
	if (existing) {
		await input.db
			.prepare(
				`UPDATE platform_provider_marks
				SET label = ?, aliases_json = ?, updated_at = ?
				WHERE slug = ?`,
			)
			.bind(label, aliasesJson, now, slug)
			.run()
	} else {
		await input.db
			.prepare(
				`INSERT INTO platform_provider_marks (
					slug, label, aliases_json, logo_key, logo_content_type,
					created_at, updated_at
				) VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
			)
			.bind(slug, label, aliasesJson, now, now)
			.run()
	}
	const saved = await getPlatformProviderMarkBySlug({
		db: input.db,
		slug,
	})
	if (!saved) {
		throw new Error(`Failed to persist provider mark "${slug}".`)
	}
	return saved
}

export async function deletePlatformProviderMark(input: {
	db: D1Database
	slug: string
}): Promise<boolean> {
	const slug = canonicalIntegrationName(input.slug)
	if (!slug) return false
	const result = await input.db
		.prepare(`DELETE FROM platform_provider_marks WHERE slug = ?`)
		.bind(slug)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function setPlatformProviderMarkLogo(input: {
	db: D1Database
	env: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'>
	slug: string
	sourceBytes: Uint8Array | null
}): Promise<PlatformProviderMark> {
	const mark = await getPlatformProviderMarkBySlug({
		db: input.db,
		slug: input.slug,
	})
	if (!mark) {
		throw new Error(`Provider mark "${input.slug}" was not found.`)
	}
	const previousKey = mark.logoKey
	let nextKey: string | null = null
	let nextContentType: PlatformOauthAppLogoContentType | null = null
	if (input.sourceBytes) {
		const processed = await processPlatformOauthAppLogo(
			input.sourceBytes,
			input.env.IMAGES,
		)
		const contentHash = (await sha256Hex(processed.bytes)).slice(0, 16)
		nextKey = `${providerMarkLogoR2KeyPrefix}${mark.slug}/${contentHash}.${extensionForContentType(processed.contentType)}`
		nextContentType = processed.contentType
		await input.env.COMMUNITY_ASSETS.put(nextKey, processed.bytes, {
			httpMetadata: {
				contentType: processed.contentType,
				cacheControl: providerMarkLogoCacheControl,
			},
		})
	}
	await input.db
		.prepare(
			`UPDATE platform_provider_marks
			SET logo_key = ?, logo_content_type = ?, updated_at = ?
			WHERE slug = ?`,
		)
		.bind(nextKey, nextContentType, new Date().toISOString(), mark.slug)
		.run()
	if (previousKey && previousKey !== nextKey) {
		try {
			await input.env.COMMUNITY_ASSETS.delete(previousKey)
		} catch (error) {
			console.error(
				'platform-provider-mark-logo-previous-delete-failed',
				previousKey,
				error,
			)
		}
	}
	const saved = await getPlatformProviderMarkBySlug({
		db: input.db,
		slug: mark.slug,
	})
	if (!saved) {
		throw new Error(
			`Provider mark "${mark.slug}" disappeared during logo update.`,
		)
	}
	return saved
}

export async function deletePlatformProviderMarkLogoAsset(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	logoKey: string | null
}) {
	if (!input.logoKey) return
	if (!input.logoKey.startsWith(providerMarkLogoR2KeyPrefix)) return
	try {
		await input.env.COMMUNITY_ASSETS.delete(input.logoKey)
	} catch (error) {
		console.error(
			'platform-provider-mark-logo-delete-failed',
			input.logoKey,
			error,
		)
	}
}

export async function loadFittedProviderMarkLogo(input: {
	env: Pick<Env, 'COMMUNITY_ASSETS'>
	mark: PlatformProviderMark
}): Promise<ServedFittedLogo | null> {
	if (!input.mark.logoKey) return null
	if (!input.mark.logoKey.startsWith(providerMarkLogoR2KeyPrefix)) return null
	const object = await input.env.COMMUNITY_ASSETS.get(input.mark.logoKey)
	if (!object) return null
	return servedLogoFromObject(
		object,
		input.mark.logoContentType,
		providerMarkLogoCacheControl,
	)
}
