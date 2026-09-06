import { parsePlanName, planNames, type PlanName } from '#universal/plans.ts'

const stableUserIdPattern = /^[a-f0-9]{64}$/

export const siteBannerLooks = ['strip', 'promo', 'card'] as const
export type SiteBannerLook = (typeof siteBannerLooks)[number]

export const siteBannerSeverities = [
	'info',
	'warning',
	'success',
	'promo',
] as const
export type SiteBannerSeverity = (typeof siteBannerSeverities)[number]

export const siteBannerPageTargetings = ['all', 'routes'] as const
export type SiteBannerPageTargeting = (typeof siteBannerPageTargetings)[number]

export const siteBannerAudiences = [
	'everyone',
	'logged_out',
	'logged_in',
	'users',
	'plans',
] as const
export type SiteBannerAudience = (typeof siteBannerAudiences)[number]

export const siteBannerIcons = ['play', 'megaphone', 'sparkle', 'info'] as const
export type SiteBannerIcon = (typeof siteBannerIcons)[number]

export const siteBannerIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const siteBannerPreviewLookParam = 'siteBannerLook'
export const siteBannerPreviewIdParam = 'siteBannerPreview'
export const launchVideoSampleBannerId = 'preview-launch-video'

export const siteBannerLookMinHeights = {
	strip: '3.25rem',
	promo: '5.75rem',
	card: '7.25rem',
} as const satisfies Record<SiteBannerLook, string>

const maxTitleLength = 120
const maxBodyLength = 400
const maxHrefLength = 500
const maxLabelLength = 40
const maxRoutePatternLength = 200
const maxRoutePatterns = 20
const maxAudienceUserIds = 50
const maxPriority = 1000

export type SiteBannerRecord = {
	id: string
	enabled: boolean
	priority: number
	title: string
	body: string
	ctaHref: string | null
	ctaLabel: string | null
	secondaryHref: string | null
	secondaryLabel: string | null
	severity: SiteBannerSeverity
	look: SiteBannerLook
	icon: SiteBannerIcon | null
	imageUrl: string | null
	pageTargeting: SiteBannerPageTargeting
	routePatterns: Array<string>
	audience: SiteBannerAudience
	audienceUserIds: Array<string>
	audiencePlans: Array<PlanName>
	dismissible: boolean
	startsAt: string | null
	endsAt: string | null
	createdBy: number | null
	updatedBy: number | null
	createdAt: string
	updatedAt: string
}

export type SiteBannerView = {
	id: string
	title: string
	body: string
	ctaHref: string | null
	ctaLabel: string | null
	secondaryHref: string | null
	secondaryLabel: string | null
	severity: SiteBannerSeverity
	look: SiteBannerLook
	icon: SiteBannerIcon | null
	imageUrl: string | null
	dismissible: boolean
}

export type SiteBannerViewer = {
	loggedIn: boolean
	stableUserId: string | null
	plan: PlanName | null
	isAdmin: boolean
}

export type SiteBannerResolveInput = {
	candidates: Array<SiteBannerRecord>
	dismissedIds: ReadonlyArray<string>
	pathname: string
	searchParams?: URLSearchParams
	viewer: SiteBannerViewer
	nowMs?: number
}

export type SiteBannerInput = {
	id?: string | null
	enabled: boolean
	priority: number
	title: string
	body: string
	ctaHref: string | null
	ctaLabel: string | null
	secondaryHref: string | null
	secondaryLabel: string | null
	severity: SiteBannerSeverity
	look: SiteBannerLook
	icon: SiteBannerIcon | null
	imageUrl: string | null
	pageTargeting: SiteBannerPageTargeting
	routePatterns: Array<string>
	audience: SiteBannerAudience
	audienceUserIds: Array<string>
	audiencePlans: Array<PlanName>
	dismissible: boolean
	startsAt: string | null
	endsAt: string | null
}

export type ParseSiteBannerInputResult =
	| { ok: true; value: SiteBannerInput }
	| { ok: false; error: string }

export function isSiteBannerLook(value: unknown): value is SiteBannerLook {
	return (
		typeof value === 'string' &&
		(siteBannerLooks as ReadonlyArray<string>).includes(value)
	)
}

export function isSiteBannerSeverity(
	value: unknown,
): value is SiteBannerSeverity {
	return (
		typeof value === 'string' &&
		(siteBannerSeverities as ReadonlyArray<string>).includes(value)
	)
}

export function isSiteBannerPageTargeting(
	value: unknown,
): value is SiteBannerPageTargeting {
	return (
		typeof value === 'string' &&
		(siteBannerPageTargetings as ReadonlyArray<string>).includes(value)
	)
}

export function isSiteBannerAudience(
	value: unknown,
): value is SiteBannerAudience {
	return (
		typeof value === 'string' &&
		(siteBannerAudiences as ReadonlyArray<string>).includes(value)
	)
}

export function isSiteBannerIcon(value: unknown): value is SiteBannerIcon {
	return (
		typeof value === 'string' &&
		(siteBannerIcons as ReadonlyArray<string>).includes(value)
	)
}

export function isSiteBannerId(value: unknown): value is string {
	return typeof value === 'string' && siteBannerIdPattern.test(value)
}

export function normalizePathname(pathname: string): string {
	const trimmed = pathname.trim()
	const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
	if (withSlash.length > 1 && withSlash.endsWith('/')) {
		return withSlash.slice(0, -1)
	}
	return withSlash
}

export function shouldHideSiteBanner(pathname: string): boolean {
	switch (normalizePathname(pathname)) {
		case '/login':
		case '/signup':
		case '/oauth/authorize':
		case '/connect/oauth':
		case '/connect/secrets':
			return true
		default:
			return false
	}
}

export function matchRoutePattern(pathname: string, pattern: string): boolean {
	const path = normalizePathname(pathname)
	const raw = pattern.trim()
	if (!raw) return false
	const normalizedPattern = normalizePathname(raw)
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3)
		if (prefix && path === prefix) return true
	}
	const source = globToRegExpSource(normalizedPattern)
	return new RegExp(`^${source}$`).test(path)
}

function globToRegExpSource(pattern: string): string {
	let source = ''
	let index = 0
	while (index < pattern.length) {
		if (pattern.startsWith('**', index)) {
			source += '.*'
			index += 2
			if (pattern[index] === '/') {
				index += 1
			}
			continue
		}
		if (pattern[index] === '*') {
			source += '[^/]+'
			index += 1
			continue
		}
		const nextStar = pattern.indexOf('*', index)
		const chunk =
			nextStar === -1 ? pattern.slice(index) : pattern.slice(index, nextStar)
		source += escapeRegExp(chunk)
		index += chunk.length
	}
	return source
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function bannerMatchesPath(
	banner: Pick<SiteBannerRecord, 'pageTargeting' | 'routePatterns'>,
	pathname: string,
): boolean {
	switch (banner.pageTargeting) {
		case 'all':
			return true
		case 'routes':
			return banner.routePatterns.some((pattern) =>
				matchRoutePattern(pathname, pattern),
			)
		default: {
			const exhaustive: never = banner.pageTargeting
			return exhaustive
		}
	}
}

export function bannerMatchesAudience(
	banner: Pick<
		SiteBannerRecord,
		'audience' | 'audienceUserIds' | 'audiencePlans'
	>,
	viewer: SiteBannerViewer,
): boolean {
	switch (banner.audience) {
		case 'everyone':
			return true
		case 'logged_out':
			return !viewer.loggedIn
		case 'logged_in':
			return viewer.loggedIn
		case 'users':
			return (
				viewer.loggedIn &&
				viewer.stableUserId !== null &&
				banner.audienceUserIds.includes(viewer.stableUserId)
			)
		case 'plans':
			return (
				viewer.loggedIn &&
				viewer.plan !== null &&
				banner.audiencePlans.includes(viewer.plan)
			)
		default: {
			const exhaustive: never = banner.audience
			return exhaustive
		}
	}
}

export function bannerIsScheduled(
	banner: Pick<SiteBannerRecord, 'startsAt' | 'endsAt'>,
	nowMs: number,
): boolean {
	if (banner.startsAt) {
		const start = Date.parse(banner.startsAt)
		if (!Number.isNaN(start) && nowMs < start) return false
	}
	if (banner.endsAt) {
		const end = Date.parse(banner.endsAt)
		if (!Number.isNaN(end) && nowMs > end) return false
	}
	return true
}

export function compareSiteBannerPriority(
	left: Pick<SiteBannerRecord, 'id' | 'priority' | 'updatedAt'>,
	right: Pick<SiteBannerRecord, 'id' | 'priority' | 'updatedAt'>,
): number {
	if (left.priority !== right.priority) {
		return right.priority - left.priority
	}
	if (left.updatedAt !== right.updatedAt) {
		return left.updatedAt < right.updatedAt ? 1 : -1
	}
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

export function toPublicSiteBannerCandidate(
	banner: SiteBannerRecord,
): SiteBannerRecord {
	return {
		...banner,
		audience: banner.audience === 'users' ? 'logged_in' : banner.audience,
		audienceUserIds: [],
		createdBy: null,
		updatedBy: null,
	}
}

export function selectSiteBannersForClient(input: {
	banners: Array<SiteBannerRecord>
	viewer: SiteBannerViewer
	includeUnmatched: boolean
	nowMs?: number
}): Array<SiteBannerRecord> {
	const nowMs = input.nowMs ?? Date.now()
	return input.banners
		.filter((banner) => {
			if (input.includeUnmatched) return true
			return (
				banner.enabled &&
				bannerIsScheduled(banner, nowMs) &&
				bannerMatchesAudience(banner, input.viewer)
			)
		})
		.map(toPublicSiteBannerCandidate)
}

export function toSiteBannerView(
	banner: SiteBannerRecord,
	lookOverride?: SiteBannerLook,
): SiteBannerView {
	return {
		id: banner.id,
		title: banner.title,
		body: banner.body,
		ctaHref: banner.ctaHref,
		ctaLabel: banner.ctaLabel,
		secondaryHref: banner.secondaryHref,
		secondaryLabel: banner.secondaryLabel,
		severity: banner.severity,
		look: lookOverride ?? banner.look,
		icon: banner.icon,
		imageUrl: banner.imageUrl,
		dismissible: banner.dismissible,
	}
}

export function createLaunchVideoSampleBanner(
	look: SiteBannerLook,
): SiteBannerView {
	return {
		id: launchVideoSampleBannerId,
		title: 'Kody is live',
		body: 'Watch the launch video — what Kody is, and why it exists.',
		ctaHref: 'https://example.com/kody-launch-video',
		ctaLabel: 'Watch the video',
		secondaryHref: '/blog',
		secondaryLabel: 'Read the announcement',
		severity: 'promo',
		look,
		icon: 'play',
		imageUrl: null,
		dismissible: true,
	}
}

export function resolveVisibleSiteBanner(
	input: SiteBannerResolveInput,
): SiteBannerView | null {
	const lookOverride = readLookOverride(input.searchParams, input.viewer)
	const previewId = readPreviewId(input.searchParams, input.viewer)
	const nowMs = input.nowMs ?? Date.now()

	if (previewId) {
		const previewed = input.candidates.find((banner) => banner.id === previewId)
		if (previewed) {
			return toSiteBannerView(previewed, lookOverride ?? undefined)
		}
	}

	if (shouldHideSiteBanner(input.pathname) && !lookOverride && !previewId) {
		return null
	}

	const eligible = input.candidates
		.filter((banner) => banner.enabled)
		.filter((banner) => bannerIsScheduled(banner, nowMs))
		.filter((banner) => bannerMatchesPath(banner, input.pathname))
		.filter((banner) => bannerMatchesAudience(banner, input.viewer))
		.filter(
			(banner) =>
				!banner.dismissible || !input.dismissedIds.includes(banner.id),
		)
		.slice()
		.sort(compareSiteBannerPriority)

	const winner = eligible[0]
	if (winner) {
		return toSiteBannerView(winner, lookOverride ?? undefined)
	}
	if (lookOverride) {
		return createLaunchVideoSampleBanner(lookOverride)
	}
	return null
}

function readLookOverride(
	searchParams: URLSearchParams | undefined,
	viewer: SiteBannerViewer,
): SiteBannerLook | null {
	if (!viewer.isAdmin || !searchParams) return null
	const value = searchParams.get(siteBannerPreviewLookParam)
	return isSiteBannerLook(value) ? value : null
}

function readPreviewId(
	searchParams: URLSearchParams | undefined,
	viewer: SiteBannerViewer,
): string | null {
	if (!viewer.isAdmin || !searchParams) return null
	const value = searchParams.get(siteBannerPreviewIdParam)
	return value && (isSiteBannerId(value) || value === launchVideoSampleBannerId)
		? value
		: null
}

export function parseBannerHref(value: unknown): string | null | false {
	if (value === null || value === undefined || value === '') return null
	if (typeof value !== 'string') return false
	const trimmed = value.trim()
	if (!trimmed) return null
	if (trimmed.length > maxHrefLength) return false
	if (trimmed.startsWith('/')) {
		if (trimmed.startsWith('//')) return false
		if (trimmed.includes('\\')) return false
		return trimmed
	}
	try {
		const url = new URL(trimmed)
		if (url.protocol !== 'https:') return false
		return url.href
	} catch {
		return false
	}
}

export function parseOptionalIsoTimestamp(
	value: unknown,
): string | null | false {
	if (value === null || value === undefined || value === '') return null
	if (typeof value !== 'string') return false
	const trimmed = value.trim()
	if (!trimmed) return null
	const parsed = Date.parse(trimmed)
	if (Number.isNaN(parsed)) return false
	return new Date(parsed).toISOString()
}

export function parseSiteBannerInput(
	body: Record<string, unknown>,
): ParseSiteBannerInputResult {
	const idValue = body.id
	let id: string | null = null
	if (idValue !== undefined && idValue !== null && idValue !== '') {
		if (!isSiteBannerId(idValue)) {
			return { ok: false, error: 'id must be a UUID.' }
		}
		id = idValue
	}

	const enabled = readBoolean(body.enabled)
	if (enabled === null) {
		return { ok: false, error: 'enabled must be a boolean.' }
	}

	const dismissible = readBoolean(body.dismissible)
	if (dismissible === null) {
		return { ok: false, error: 'dismissible must be a boolean.' }
	}

	const priority = readPriority(body.priority)
	if (priority === null) {
		return {
			ok: false,
			error: `priority must be an integer between 0 and ${String(maxPriority)}.`,
		}
	}

	const title = readBoundedString(body.title, 1, maxTitleLength)
	if (title === null) {
		return {
			ok: false,
			error: `title is required and must be at most ${String(maxTitleLength)} characters.`,
		}
	}

	const bodyText = readBoundedString(body.body ?? '', 0, maxBodyLength)
	if (bodyText === null) {
		return {
			ok: false,
			error: `body must be at most ${String(maxBodyLength)} characters.`,
		}
	}

	const ctaHref = parseBannerHref(body.ctaHref)
	if (ctaHref === false) {
		return {
			ok: false,
			error: 'ctaHref must be a relative path or https URL.',
		}
	}
	const ctaLabel = readBoundedString(body.ctaLabel ?? '', 0, maxLabelLength)
	if (ctaLabel === null) {
		return {
			ok: false,
			error: `ctaLabel must be at most ${String(maxLabelLength)} characters.`,
		}
	}
	if ((ctaHref && !ctaLabel) || (!ctaHref && ctaLabel)) {
		return {
			ok: false,
			error: 'ctaHref and ctaLabel must be set together.',
		}
	}

	const secondaryHref = parseBannerHref(body.secondaryHref)
	if (secondaryHref === false) {
		return {
			ok: false,
			error: 'secondaryHref must be a relative path or https URL.',
		}
	}
	const secondaryLabel = readBoundedString(
		body.secondaryLabel ?? '',
		0,
		maxLabelLength,
	)
	if (secondaryLabel === null) {
		return {
			ok: false,
			error: `secondaryLabel must be at most ${String(maxLabelLength)} characters.`,
		}
	}
	if (
		(secondaryHref && !secondaryLabel) ||
		(!secondaryHref && secondaryLabel)
	) {
		return {
			ok: false,
			error: 'secondaryHref and secondaryLabel must be set together.',
		}
	}

	if (!isSiteBannerSeverity(body.severity)) {
		return { ok: false, error: 'severity is invalid.' }
	}
	if (!isSiteBannerLook(body.look)) {
		return { ok: false, error: 'look is invalid.' }
	}
	if (!isSiteBannerPageTargeting(body.pageTargeting)) {
		return { ok: false, error: 'pageTargeting is invalid.' }
	}
	if (!isSiteBannerAudience(body.audience)) {
		return { ok: false, error: 'audience is invalid.' }
	}

	const iconValue = body.icon
	let icon: SiteBannerIcon | null = null
	if (iconValue !== undefined && iconValue !== null && iconValue !== '') {
		if (!isSiteBannerIcon(iconValue)) {
			return { ok: false, error: 'icon is invalid.' }
		}
		icon = iconValue
	}

	const imageUrl = parseBannerHref(body.imageUrl)
	if (imageUrl === false) {
		return {
			ok: false,
			error: 'imageUrl must be a relative path or https URL.',
		}
	}

	const routePatterns = readStringList(body.routePatterns, maxRoutePatterns)
	if (routePatterns === null) {
		return {
			ok: false,
			error: `routePatterns must be at most ${String(maxRoutePatterns)} non-empty patterns.`,
		}
	}
	if (
		routePatterns.some(
			(pattern) =>
				pattern.length > maxRoutePatternLength || !pattern.startsWith('/'),
		)
	) {
		return {
			ok: false,
			error:
				'Each route pattern must start with / and stay under 200 characters.',
		}
	}
	if (body.pageTargeting === 'routes' && routePatterns.length === 0) {
		return {
			ok: false,
			error: 'Route targeting requires at least one route pattern.',
		}
	}

	const audienceUserIds = readStableUserIdList(body.audienceUserIds)
	if (audienceUserIds === null) {
		return {
			ok: false,
			error: 'audienceUserIds must be stable user ids.',
		}
	}
	if (body.audience === 'users' && audienceUserIds.length === 0) {
		return {
			ok: false,
			error: 'Specific-user targeting requires at least one stable user id.',
		}
	}

	const audiencePlans = readPlanList(body.audiencePlans)
	if (audiencePlans === null) {
		return { ok: false, error: 'audiencePlans must be registered plan names.' }
	}
	if (body.audience === 'plans' && audiencePlans.length === 0) {
		return {
			ok: false,
			error: 'Plan targeting requires at least one plan.',
		}
	}

	const startsAt = parseOptionalIsoTimestamp(body.startsAt)
	if (startsAt === false) {
		return { ok: false, error: 'startsAt must be an ISO timestamp.' }
	}
	const endsAt = parseOptionalIsoTimestamp(body.endsAt)
	if (endsAt === false) {
		return { ok: false, error: 'endsAt must be an ISO timestamp.' }
	}
	if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
		return { ok: false, error: 'endsAt must be at or after startsAt.' }
	}

	return {
		ok: true,
		value: {
			id,
			enabled,
			priority,
			title,
			body: bodyText,
			ctaHref,
			ctaLabel: ctaLabel || null,
			secondaryHref,
			secondaryLabel: secondaryLabel || null,
			severity: body.severity,
			look: body.look,
			icon,
			imageUrl,
			pageTargeting: body.pageTargeting,
			routePatterns,
			audience: body.audience,
			audienceUserIds,
			audiencePlans,
			dismissible,
			startsAt,
			endsAt,
		},
	}
}

function readBoolean(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value
	if (value === 'true') return true
	if (value === 'false') return false
	return null
}

function readPriority(value: unknown): number | null {
	if (typeof value === 'number' && Number.isInteger(value)) {
		return value >= 0 && value <= maxPriority ? value : null
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim())
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > maxPriority) {
			return null
		}
		return parsed
	}
	return null
}

function readBoundedString(
	value: unknown,
	min: number,
	max: number,
): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (trimmed.length < min || trimmed.length > max) return null
	return trimmed
}

function readStringList(
	value: unknown,
	maxItems: number,
): Array<string> | null {
	if (value === undefined || value === null || value === '') return []
	if (typeof value === 'string') {
		const items = value
			.split(/[\n,]/)
			.map((item) => item.trim())
			.filter(Boolean)
		return items.length <= maxItems ? uniqueStrings(items) : null
	}
	if (!Array.isArray(value)) return null
	const items: Array<string> = []
	for (const entry of value) {
		if (typeof entry !== 'string') return null
		const trimmed = entry.trim()
		if (!trimmed) continue
		items.push(trimmed)
	}
	return items.length <= maxItems ? uniqueStrings(items) : null
}

function readStableUserIdList(value: unknown): Array<string> | null {
	const items = readStringList(value, maxAudienceUserIds)
	if (items === null) return null
	const ids: Array<string> = []
	for (const item of items) {
		const normalized = item.trim()
		if (!stableUserIdPattern.test(normalized)) return null
		ids.push(normalized)
	}
	return uniqueStrings(ids)
}

function readPlanList(value: unknown): Array<PlanName> | null {
	const items = readStringList(value, planNames.length)
	if (items === null) return null
	const plans: Array<PlanName> = []
	for (const item of items) {
		const plan = parsePlanName(item)
		if (!plan) return null
		plans.push(plan)
	}
	return uniqueStrings(plans) as Array<PlanName>
}

function uniqueStrings(items: Array<string>): Array<string> {
	return [...new Set(items)]
}
