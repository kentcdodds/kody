import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import {
	orgOwnedAccountApiSection,
	orgSectionKeysOnPerson,
	orgSlugFromOrgOwnedPath,
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
		(apiSection && !orgSectionKeysOnPerson(apiSection)
			? orgSlugFromAccountApiReferer(request, url.origin)
			: null)
	if (!slug) return 'personal'
	const binding = await loadOrgBindingForSlug(env.APP_DB, personId, slug)
	return binding ?? 'denied'
}
