import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import {
	parseOrgBillingPath,
	parseOrgManagementPath,
	parseOrgResourcePath,
} from '#universal/org-pages.ts'

export type RequestOrgResolution = OrgBinding | 'personal' | 'denied'

const resolutions = new WeakMap<Request, Promise<RequestOrgResolution>>()

/**
 * The organization for this request. Resource, billing, and management URLs
 * under `/@slug/...` bind that organization when the actor is a member or
 * holds a grant. Every other URL keeps the signup organization.
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

async function resolveRequestOrg(
	request: Request,
	env: Env,
	personId: string,
): Promise<RequestOrgResolution> {
	const pathname = new URL(request.url).pathname
	const slug =
		parseOrgResourcePath(pathname)?.slug ??
		parseOrgBillingPath(pathname)?.slug ??
		parseOrgManagementPath(pathname)?.slug
	if (!slug) return 'personal'
	const binding = await loadOrgBindingForSlug(env.APP_DB, personId, slug)
	return binding ?? 'denied'
}
