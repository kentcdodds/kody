import {
	isSiteBannerAudience,
	isSiteBannerIcon,
	isSiteBannerId,
	isSiteBannerLook,
	isSiteBannerPageTargeting,
	isSiteBannerSeverity,
	type SiteBannerInput,
	type SiteBannerRecord,
} from '#universal/site-banners.ts'
import { parsePlanName, type PlanName } from '#universal/plans.ts'

type SiteBannerRow = {
	id: string
	enabled: number
	priority: number
	title: string
	body: string
	cta_href: string | null
	cta_label: string | null
	secondary_href: string | null
	secondary_label: string | null
	severity: string
	look: string
	icon: string | null
	image_url: string | null
	page_targeting: string
	route_patterns: string
	audience: string
	audience_user_ids: string
	audience_plans: string
	dismissible: number
	starts_at: string | null
	ends_at: string | null
	created_by: number | null
	updated_by: number | null
	created_at: string
	updated_at: string
}

const listColumns = `id, enabled, priority, title, body, cta_href, cta_label,
	secondary_href, secondary_label, severity, look, icon, image_url,
	page_targeting, route_patterns, audience, audience_user_ids, audience_plans,
	dismissible, starts_at, ends_at, created_by, updated_by, created_at, updated_at`

export async function listSiteBannersForAdmin(
	db: D1Database,
): Promise<Array<SiteBannerRecord>> {
	const result = await db
		.prepare(
			`SELECT ${listColumns}
			 FROM site_banners
			 ORDER BY priority DESC, updated_at DESC, id ASC`,
		)
		.all<SiteBannerRow>()
	return (result.results ?? []).map(mapSiteBannerRow)
}

export async function listEnabledSiteBanners(
	db: D1Database,
): Promise<Array<SiteBannerRecord>> {
	const result = await db
		.prepare(
			`SELECT ${listColumns}
			 FROM site_banners
			 WHERE enabled = 1
			 ORDER BY priority DESC, updated_at DESC, id ASC`,
		)
		.all<SiteBannerRow>()
	return (result.results ?? []).map(mapSiteBannerRow)
}

export async function getSiteBanner(
	db: D1Database,
	id: string,
): Promise<SiteBannerRecord | null> {
	if (!isSiteBannerId(id)) return null
	const row = await db
		.prepare(`SELECT ${listColumns} FROM site_banners WHERE id = ?`)
		.bind(id)
		.first<SiteBannerRow>()
	return row ? mapSiteBannerRow(row) : null
}

export async function saveSiteBanner(
	db: D1Database,
	input: {
		banner: SiteBannerInput
		actorUserId: number
	},
): Promise<SiteBannerRecord> {
	const banner = input.banner
	const id = banner.id ?? crypto.randomUUID()
	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO site_banners (
				id, enabled, priority, title, body, cta_href, cta_label,
				secondary_href, secondary_label, severity, look, icon, image_url,
				page_targeting, route_patterns, audience, audience_user_ids,
				audience_plans, dismissible, starts_at, ends_at, created_by,
				updated_by, created_at, updated_at
			) VALUES (
				?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			)
			ON CONFLICT(id) DO UPDATE SET
				enabled = excluded.enabled,
				priority = excluded.priority,
				title = excluded.title,
				body = excluded.body,
				cta_href = excluded.cta_href,
				cta_label = excluded.cta_label,
				secondary_href = excluded.secondary_href,
				secondary_label = excluded.secondary_label,
				severity = excluded.severity,
				look = excluded.look,
				icon = excluded.icon,
				image_url = excluded.image_url,
				page_targeting = excluded.page_targeting,
				route_patterns = excluded.route_patterns,
				audience = excluded.audience,
				audience_user_ids = excluded.audience_user_ids,
				audience_plans = excluded.audience_plans,
				dismissible = excluded.dismissible,
				starts_at = excluded.starts_at,
				ends_at = excluded.ends_at,
				updated_by = excluded.updated_by,
				updated_at = excluded.updated_at`,
		)
		.bind(
			id,
			banner.enabled ? 1 : 0,
			banner.priority,
			banner.title,
			banner.body,
			banner.ctaHref,
			banner.ctaLabel,
			banner.secondaryHref,
			banner.secondaryLabel,
			banner.severity,
			banner.look,
			banner.icon,
			banner.imageUrl,
			banner.pageTargeting,
			JSON.stringify(banner.routePatterns),
			banner.audience,
			JSON.stringify(banner.audienceUserIds),
			JSON.stringify(banner.audiencePlans),
			banner.dismissible ? 1 : 0,
			banner.startsAt,
			banner.endsAt,
			input.actorUserId,
			input.actorUserId,
			now,
			now,
		)
		.run()
	const saved = await getSiteBanner(db, id)
	if (!saved) {
		throw new Error('Banner was not found after save.')
	}
	return saved
}

export async function deleteSiteBanner(
	db: D1Database,
	id: string,
): Promise<boolean> {
	if (!isSiteBannerId(id)) return false
	const result = await db
		.prepare(`DELETE FROM site_banners WHERE id = ?`)
		.bind(id)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function listDismissedBannerIds(
	db: D1Database,
	userId: number,
): Promise<Array<string>> {
	const result = await db
		.prepare(`SELECT banner_id FROM site_banner_dismissals WHERE user_id = ?`)
		.bind(userId)
		.all<{ banner_id: string }>()
	return (result.results ?? []).map((row) => row.banner_id)
}

export async function dismissSiteBannerForUser(
	db: D1Database,
	input: { bannerId: string; userId: number },
): Promise<void> {
	if (!isSiteBannerId(input.bannerId)) return
	await db
		.prepare(
			`INSERT OR IGNORE INTO site_banner_dismissals (banner_id, user_id)
			 VALUES (?, ?)`,
		)
		.bind(input.bannerId, input.userId)
		.run()
}

function mapSiteBannerRow(row: SiteBannerRow): SiteBannerRecord {
	return {
		id: row.id,
		enabled: row.enabled === 1,
		priority: row.priority,
		title: row.title,
		body: row.body,
		ctaHref: row.cta_href,
		ctaLabel: row.cta_label,
		secondaryHref: row.secondary_href,
		secondaryLabel: row.secondary_label,
		severity: isSiteBannerSeverity(row.severity) ? row.severity : 'info',
		look: isSiteBannerLook(row.look) ? row.look : 'strip',
		icon: isSiteBannerIcon(row.icon) ? row.icon : null,
		imageUrl: row.image_url,
		pageTargeting: isSiteBannerPageTargeting(row.page_targeting)
			? row.page_targeting
			: 'all',
		routePatterns: parseJsonStringList(row.route_patterns),
		audience: isSiteBannerAudience(row.audience) ? row.audience : 'everyone',
		audienceUserIds: parseJsonStringList(row.audience_user_ids),
		audiencePlans: parseJsonPlanList(row.audience_plans),
		dismissible: row.dismissible === 1,
		startsAt: row.starts_at,
		endsAt: row.ends_at,
		createdBy: row.created_by,
		updatedBy: row.updated_by,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function parseJsonStringList(raw: string): Array<string> {
	try {
		const parsed: unknown = JSON.parse(raw)
		if (!Array.isArray(parsed)) return []
		return parsed.filter((item): item is string => typeof item === 'string')
	} catch {
		return []
	}
}

function parseJsonPlanList(raw: string): Array<PlanName> {
	const plans: Array<PlanName> = []
	for (const item of parseJsonStringList(raw)) {
		const plan = parsePlanName(item)
		if (plan) plans.push(plan)
	}
	return plans
}
