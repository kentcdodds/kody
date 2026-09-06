import { loadResolvedRequestAuth } from '#app/request-auth-cache.ts'
import { getUserPlan } from '#worker/entitlements/service.ts'
import {
	listDismissedBannerIds,
	listEnabledSiteBanners,
	listSiteBannersForAdmin,
} from '#worker/site-banners/service.ts'
import { readSiteBannerDismissCookie } from '#universal/site-banner-cookie.ts'
import {
	resolveVisibleSiteBanner,
	siteBannerPreviewIdParam,
	siteBannerPreviewLookParam,
	type SiteBannerViewer,
} from '#universal/site-banners.ts'
import { type SiteBannerLoaderData } from '#universal/loader-data.ts'
import { userHasRole } from '#universal/permissions.ts'
import { type SessionInfo } from '#app/session-info.ts'

export type { SiteBannerLoaderData }

const emptyViewer: SiteBannerViewer = {
	loggedIn: false,
	stableUserId: null,
	plan: null,
	isAdmin: false,
}

export function emptySiteBannerLoaderData(): SiteBannerLoaderData {
	return {
		banner: null,
		candidates: [],
		dismissedIds: [],
		viewer: emptyViewer,
	}
}

export async function loadSiteBannerLoaderData(input: {
	request: Request
	env: Env
	session: SessionInfo | null
	pathname: string
}): Promise<SiteBannerLoaderData> {
	try {
		return await loadSiteBannerLoaderDataUnsafe(input)
	} catch (error) {
		console.error('site banner load failed', error)
		return emptySiteBannerLoaderData()
	}
}

async function loadSiteBannerLoaderDataUnsafe(input: {
	request: Request
	env: Env
	session: SessionInfo | null
	pathname: string
}): Promise<SiteBannerLoaderData> {
	const requestUrl = new URL(input.request.url)
	const isAdmin = Boolean(input.session && userHasRole(input.session, 'admin'))
	const wantsPreview =
		isAdmin &&
		(requestUrl.searchParams.has(siteBannerPreviewLookParam) ||
			requestUrl.searchParams.has(siteBannerPreviewIdParam))

	const cookieDismissed = readSiteBannerDismissCookie(
		input.request.headers.get('Cookie'),
	)
	const auth = input.session
		? await loadResolvedRequestAuth(input.request, input.env)
		: null
	const dbUserId = auth?.user?.userId ?? null
	const stableUserId = auth?.user?.mcpUser.userId ?? null
	const dismissedIds = dbUserId
		? uniqueIds([
				...cookieDismissed,
				...(await listDismissedBannerIds(input.env.APP_DB, dbUserId)),
			])
		: cookieDismissed

	const candidates = wantsPreview
		? await listSiteBannersForAdmin(input.env.APP_DB)
		: await listEnabledSiteBanners(input.env.APP_DB)

	const needsPlan =
		Boolean(stableUserId) &&
		candidates.some((banner) => banner.audience === 'plans')
	const plan =
		needsPlan && stableUserId
			? await getUserPlan(input.env.APP_DB, {
					userId: stableUserId,
					email: auth?.user?.email,
				})
			: null

	const viewer: SiteBannerViewer = {
		loggedIn: Boolean(input.session),
		stableUserId,
		plan,
		isAdmin,
	}

	return {
		banner: resolveVisibleSiteBanner({
			candidates,
			dismissedIds,
			pathname: input.pathname,
			searchParams: requestUrl.searchParams,
			viewer,
		}),
		candidates,
		dismissedIds,
		viewer,
	}
}

function uniqueIds(ids: Array<string>): Array<string> {
	return [...new Set(ids)]
}
