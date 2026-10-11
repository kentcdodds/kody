import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import {
	orgOwnedAccountApiSection,
	orgOwnedSectionForPath,
	orgSlugFromOrgOwnedPath,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'

export type RequestOrgResolution = OrgBinding | 'personal' | 'denied'

const resolutions = new WeakMap<Request, Promise<RequestOrgResolution>>()

/**
 * The organization for this request. Resource, billing, and management URLs
 * under `/@slug/...` bind that organization when the actor is a member or
 * holds a grant. Org-owned `/account/<section>.json` fetches from those pages
 * bind the same org via Referer. Every other URL keeps the signup organization.
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
	if (resolution.role == null && section !== 'connections') {
		return 'Organization resources unavailable'
	}
	return null
}

/** URLs whose org comes from the path or, for account JSON, the Referer. */
export function isOrgBoundPath(pathname: string): boolean {
	return (
		orgOwnedAccountApiSection(pathname) !== null ||
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
	return orgSlugFromPageUrl(referer.pathname)
}

async function resolveRequestOrg(
	request: Request,
	env: Env,
	personId: string,
): Promise<RequestOrgResolution> {
	const url = new URL(request.url)
	const slugOnPage = orgSlugFromPageUrl(url.pathname)
	const apiSection = orgOwnedAccountApiSection(url.pathname)
	const slug =
		slugOnPage ??
		(apiSection ? orgSlugFromAccountApiReferer(request, url.origin) : null)
	if (!slug) return 'personal'
	const binding = await loadOrgBindingForSlug(env.APP_DB, personId, slug)
	return binding ?? 'denied'
}
