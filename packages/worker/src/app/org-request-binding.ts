import { loadOrgBindingForSlug, type OrgBinding } from '#worker/orgs/repo.ts'
import { parseOrgResourcePath } from '#universal/org-pages.ts'

export type RequestOrgResolution = OrgBinding | 'personal' | 'denied'

const resolutions = new WeakMap<Request, Promise<RequestOrgResolution>>()

/**
 * The organization for this request. Resource URLs under `/@slug/...` bind
 * that organization when the actor is a member or holds a grant. Every other
 * URL keeps the signup organization.
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
	const parsed = parseOrgResourcePath(new URL(request.url).pathname)
	if (!parsed) return 'personal'
	const binding = await loadOrgBindingForSlug(env.APP_DB, personId, parsed.slug)
	return binding ?? 'denied'
}
