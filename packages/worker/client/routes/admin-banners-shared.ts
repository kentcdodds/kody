import { planNames, type PlanName } from '#universal/plans.ts'
import {
	createLaunchVideoSampleBanner,
	type SiteBannerAudience,
	type SiteBannerIcon,
	type SiteBannerInput,
	type SiteBannerLook,
	type SiteBannerPageTargeting,
	type SiteBannerRecord,
	type SiteBannerSeverity,
	type SiteBannerView,
} from '#universal/site-banners.ts'

export const adminBannersApiPath = '/admin/banners.json'
export const adminBannersPath = '/admin/banners'

export type BannerDraft = {
	id: string | null
	enabled: boolean
	priority: string
	title: string
	body: string
	ctaHref: string
	ctaLabel: string
	secondaryHref: string
	secondaryLabel: string
	severity: SiteBannerSeverity
	look: SiteBannerLook
	icon: SiteBannerIcon | ''
	imageUrl: string
	pageTargeting: SiteBannerPageTargeting
	routePatterns: string
	audience: SiteBannerAudience
	audienceUserIds: string
	audiencePlans: Array<PlanName>
	dismissible: boolean
	startsAt: string
	endsAt: string
}

export function isAdminBannersPath(href: string) {
	return new URL(href, 'http://localhost').pathname === adminBannersPath
}

export function emptyDraft(): BannerDraft {
	const sample = createLaunchVideoSampleBanner('strip')
	return {
		id: null,
		enabled: false,
		priority: '10',
		title: sample.title,
		body: sample.body,
		ctaHref: sample.ctaHref ?? '',
		ctaLabel: sample.ctaLabel ?? '',
		secondaryHref: sample.secondaryHref ?? '',
		secondaryLabel: sample.secondaryLabel ?? '',
		severity: 'promo',
		look: 'strip',
		icon: 'play',
		imageUrl: '',
		pageTargeting: 'all',
		routePatterns: '',
		audience: 'everyone',
		audienceUserIds: '',
		audiencePlans: [],
		dismissible: true,
		startsAt: '',
		endsAt: '',
	}
}

export function bannerAfterSave(
	banners: Array<SiteBannerRecord>,
	savedBannerId: string | undefined,
): SiteBannerRecord | null {
	if (!savedBannerId) return null
	return banners.find((banner) => banner.id === savedBannerId) ?? null
}

export function draftFromBanner(banner: SiteBannerRecord): BannerDraft {
	return {
		id: banner.id,
		enabled: banner.enabled,
		priority: String(banner.priority),
		title: banner.title,
		body: banner.body,
		ctaHref: banner.ctaHref ?? '',
		ctaLabel: banner.ctaLabel ?? '',
		secondaryHref: banner.secondaryHref ?? '',
		secondaryLabel: banner.secondaryLabel ?? '',
		severity: banner.severity,
		look: banner.look,
		icon: banner.icon ?? '',
		imageUrl: banner.imageUrl ?? '',
		pageTargeting: banner.pageTargeting,
		routePatterns: banner.routePatterns.join('\n'),
		audience: banner.audience,
		audienceUserIds: banner.audienceUserIds.join('\n'),
		audiencePlans: [...banner.audiencePlans],
		dismissible: banner.dismissible,
		startsAt: banner.startsAt ?? '',
		endsAt: banner.endsAt ?? '',
	}
}

export function draftToInput(draft: BannerDraft): SiteBannerInput {
	return {
		id: draft.id,
		enabled: draft.enabled,
		priority: Number(draft.priority),
		title: draft.title,
		body: draft.body,
		ctaHref: draft.ctaHref.trim() || null,
		ctaLabel: draft.ctaLabel.trim() || null,
		secondaryHref: draft.secondaryHref.trim() || null,
		secondaryLabel: draft.secondaryLabel.trim() || null,
		severity: draft.severity,
		look: draft.look,
		icon: draft.icon || null,
		imageUrl: draft.imageUrl.trim() || null,
		pageTargeting: draft.pageTargeting,
		routePatterns: draft.routePatterns
			.split(/[\n,]/)
			.map((item) => item.trim())
			.filter(Boolean),
		audience: draft.audience,
		audienceUserIds: draft.audienceUserIds
			.split(/[\n,]/)
			.map((item) => item.trim())
			.filter(Boolean),
		audiencePlans: [...draft.audiencePlans],
		dismissible: draft.dismissible,
		startsAt: draft.startsAt.trim() || null,
		endsAt: draft.endsAt.trim() || null,
	}
}

export function draftToPreview(
	draft: BannerDraft,
	look: SiteBannerLook,
): SiteBannerView {
	return {
		id: draft.id ?? `preview-${look}`,
		title: draft.title.trim() || 'Untitled banner',
		body: draft.body,
		ctaHref: draft.ctaHref.trim() || null,
		ctaLabel: draft.ctaLabel.trim() || null,
		secondaryHref: draft.secondaryHref.trim() || null,
		secondaryLabel: draft.secondaryLabel.trim() || null,
		severity: draft.severity,
		look,
		icon: draft.icon || null,
		imageUrl: draft.imageUrl.trim() || null,
		dismissible: draft.dismissible,
	}
}

export function audienceLabel(audience: SiteBannerAudience) {
	switch (audience) {
		case 'everyone':
			return 'Everyone'
		case 'logged_out':
			return 'Logged-out only'
		case 'logged_in':
			return 'Logged-in only'
		case 'users':
			return 'Specific users'
		case 'plans':
			return 'Plans'
		default: {
			const exhaustive: never = audience
			return exhaustive
		}
	}
}

export function lookLabel(look: SiteBannerLook) {
	switch (look) {
		case 'strip':
			return 'A · Slim strip'
		case 'promo':
			return 'B · Promo strip'
		case 'card':
			return 'C · Card announcement'
		default: {
			const exhaustive: never = look
			return exhaustive
		}
	}
}

export { planNames }
