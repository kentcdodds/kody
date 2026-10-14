import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import { readOrgSlugFromUrl } from '#universal/org-binding/url.ts'
import { isLastUsedOrgCommitApiPath } from '#universal/org-last-used-cookie.ts'
import {
	orgOwnedAccountApiSection,
	orgOwnedSectionForPath,
	orgSlugFromOrgOwnedPath,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'

/** Credits top-up / settings stay on `/account/credits/*.json` and bind via Referer. */
function isCreditsApiPath(pathname: string) {
	return (
		pathname === routes.accountCreditsTopUpPost.href() ||
		pathname === routes.accountCreditsSettingsPost.href()
	)
}

export type RequestOrgResolution = OrgBinding | 'personal' | 'denied'

const resolutions = new WeakMap<Request, Promise<RequestOrgResolution>>()

/**
 * The organization for this request. Resource, billing, usage, and management
 * URLs under `/@slug/...` bind that organization when the actor is a member or
 * holds a grant. Org-owned `/account/<section>.json` and credits mutation APIs
 * bind the same org via Referer. `/connect/oauth?org=<slug>` binds that org so
 * team credential handoffs keep writes off the signup org (the redirect URI
 * itself stays org-less). Credits mutations without a usable Referer are
 * denied (no personal fallback). Every other URL keeps the signup
 * organization.
 */
export function loadRequestOrgResolution(
	request: Request,
	env: Env,
	personId: string,
): Promise<RequestOrgResolution> {
	const cached = resolutions.get(request)
	if (cached) return cached
	const pending = resolveRequestOrg(request, env, personId)
	resolutions.set(request, pending)
	return pending
}

/**
 * Why `/@slug/-/<section>` is closed to this person, or null when it is open.
 */
export function orgSectionDenial(
	resolution: RequestOrgResolution,
	section: OrgOwnedAccountSection,
): string | null {
	if (resolution === 'denied' || resolution === 'personal') {
		return 'Organization unavailable'
	}
	// A grant without a membership is not access to the whole workspace.
	// Connections only lists the viewer's own agents bound to this org, which
	// is how a collaborator starts using what was shared with them.
	if (resolution.role == null && section !== 'agents') {
		return 'Organization resources unavailable'
	}
	return null
}

/** URLs whose org comes from the path, query, or, for account JSON, the Referer. */
export function isOrgBoundPath(pathname: string): boolean {
	return (
		orgOwnedAccountApiSection(pathname) !== null ||
		isCreditsApiPath(pathname) ||
		isLastUsedOrgCommitApiPath(pathname) ||
		pathname === routes.connectOauth.href() ||
		orgSlugFromPageUrl(pathname) !== null
	)
}

/**
 * True when this request names an org the person cannot use: an `/@slug/-/…`
 * URL for an org they neither belong to nor hold a grant in, or a section URL
 * (page, its JSON, or org-owned `/account/<section>.json` via Referer) that
 * {@link orgSectionDenial} closes to them. `readAuthenticatedAppUser` falls
 * back to the signup org for a denied org, so these requests must stop before
 * any handler runs. Billing and management URLs only need the org; their
 * handlers check the permission.
 */
export async function isOrgRequestDenied(
	request: Request,
	env: Env,
	personId: string,
): Promise<boolean> {
	const pathname = new URL(request.url).pathname
	if (!isOrgBoundPath(pathname)) return false
	const resolution = await loadRequestOrgResolution(request, env, personId)
	if (resolution === 'denied') return true
	if (resolution === 'personal') return false
	const section = orgOwnedSectionForPath(pathname)
	return section !== null && orgSectionDenial(resolution, section) !== null
}

function orgSlugFromPageUrl(pathname: string): string | null {
	return orgSlugFromOrgOwnedPath(pathname)
}

/** `/connect/oauth` keeps a fixed redirect URI; the destination org is `?org=`. */
function orgSlugFromConnectOauthUrl(url: URL): string | null {
	if (url.pathname !== routes.connectOauth.href()) return null
	return readOrgSlugFromUrl(url)
}

/**
 * Account JSON stays on `/account/<section>.json`. A same-origin fetch from
 * `/@slug/-/...` sends that page as Referer, and the section then binds that
 * org. Membership is still required. A missing or foreign Referer keeps the
 * signup org.
 */
function orgSlugFromAccountApiReferer(
	request: Request,
	origin: string,
): string | null {
	const header = request.headers.get('referer')
	if (!header) return null
	let referer: URL
	try {
		referer = new URL(header)
	} catch {
		return null
	}
	if (referer.origin !== origin) return null
	return (
		orgSlugFromPageUrl(referer.pathname) ?? orgSlugFromConnectOauthUrl(referer)
	)
}

async function resolveRequestOrg(
	request: Request,
	env: Env,
	personId: string,
): Promise<RequestOrgResolution> {
	const url = new URL(request.url)
	const slugOnPage = orgSlugFromPageUrl(url.pathname)
	const apiSection = orgOwnedAccountApiSection(url.pathname)
	const creditsApi = isCreditsApiPath(url.pathname)
	const lastUsedCommit = isLastUsedOrgCommitApiPath(url.pathname)
	const slug =
		slugOnPage ??
		orgSlugFromConnectOauthUrl(url) ??
		(apiSection || creditsApi || lastUsedCommit
			? orgSlugFromAccountApiReferer(request, url.origin)
			: null)
	// Credits mutations must name an org (path or usage-page Referer). Falling
	// back to personal would top up the wrong wallet when Referer is missing.
	if (!slug) return creditsApi ? 'denied' : 'personal'
	const binding = await loadOrgBindingForSlug(env.APP_DB, personId, slug)
	return binding ?? 'denied'
}
