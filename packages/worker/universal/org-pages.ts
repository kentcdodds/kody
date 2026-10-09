import { type OrgRole } from '@kody-internal/shared/request-context.ts'

/**
 * Account sections that own organization resources. Person pages (login,
 * passkeys, email claims, experiments, billing) stay on `/account`.
 * Billing stays there until the billing move.
 */
const orgOwnedAccountSections = [
	'activity',
	'connections',
	'email',
	'integrations',
	'jobs',
	'mcp-servers',
	'memories',
	'packages',
	'secret-providers',
	'secrets',
	'shared',
	'values',
	'waiting',
	'webhooks',
	'workflows',
] as const

export type OrgOwnedAccountSection = (typeof orgOwnedAccountSections)[number]

const orgOwnedSectionSet: ReadonlySet<string> = new Set(orgOwnedAccountSections)

/** Sections whose org URL is only the index. Nested paths stay on other routes. */
const exactOrgSections: ReadonlySet<string> = new Set([
	'packages',
	'shared',
	'webhooks',
])

export type OrganizationSummary = {
	slug: string
	displayName: string | null
	role: OrgRole | null
	/** Signup organization (org id equals the person id). Not a user-facing label. */
	personal: boolean
}

export type OrgSwitcherEntry =
	| { kind: 'org'; org: OrganizationSummary; showRole: boolean }
	| { kind: 'create' }
	| { kind: 'invites'; count: number }

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/

export function isOrganizationSlug(value: string) {
	return slugPattern.test(value)
}

function isOrgOwnedAccountSection(
	section: string,
): section is OrgOwnedAccountSection {
	return orgOwnedSectionSet.has(section)
}

export type ParsedOrgResourcePath = {
	slug: string
	section: OrgOwnedAccountSection
	rest: string
}

/**
 * `/@acme/secrets/new` → slug, section, rest. Package-app and webhook ingress
 * paths under `packages` and `webhooks` are not account pages.
 */
export function parseOrgResourcePath(
	pathname: string,
): ParsedOrgResourcePath | null {
	const match = /^\/@([^/]+)\/([^/]+)(\/.*)?$/.exec(pathname)
	if (!match) return null
	const slug = match[1] ?? ''
	const section = match[2] ?? ''
	const rest = (match[3] ?? '').replace(/^\//, '').replace(/\/$/, '')
	if (!isOrganizationSlug(slug) || !isOrgOwnedAccountSection(section)) {
		return null
	}
	if (exactOrgSections.has(section) && rest) return null
	return { slug, section, rest }
}

/** Slug of `/@slug` or `/@slug/...`, when the first segment is a handle. */
export function orgSlugFromPathname(pathname: string) {
	const match = /^\/@([^/]+)(?:\/|$)/.exec(pathname)
	const slug = match?.[1] ?? ''
	return isOrganizationSlug(slug) ? slug : null
}

export function orgResourcePath(
	slug: string,
	section: OrgOwnedAccountSection,
	rest = '',
) {
	const suffix = rest.replace(/^\/+|\/+$/g, '')
	return suffix ? `/@${slug}/${section}/${suffix}` : `/@${slug}/${section}`
}

/**
 * Short-lived redirect from an `/account/...` resource page to the person's
 * signup organization. JSON stays on `/account`. Package detail URLs keep
 * their existing canonical redirect.
 */
export function isAccountResourceRedirectPath(pathname: string) {
	return accountResourceRedirectPath(pathname, 'org') !== null
}

export function accountResourceRedirectPath(
	pathname: string,
	personalSlug: string,
) {
	if (!isOrganizationSlug(personalSlug)) return null
	if (pathname === '/account/packages' || pathname === '/account/packages/') {
		return orgResourcePath(personalSlug, 'packages')
	}
	const match = /^\/account\/([^/]+)(\/.*)?$/.exec(pathname)
	if (!match) return null
	const section = match[1] ?? ''
	if (section.endsWith('.json') || section === 'packages') return null
	if (!isOrgOwnedAccountSection(section)) return null
	const rest = (match[2] ?? '').replace(/^\//, '').replace(/\/$/, '')
	if (exactOrgSections.has(section) && rest) return null
	return orgResourcePath(personalSlug, section, rest)
}

/**
 * Map an organization resource URL back to the `/account` path the existing
 * loaders already understand.
 */
export function accountAliasPath(pathname: string) {
	const parsed = parseOrgResourcePath(pathname)
	if (!parsed) return pathname
	return parsed.rest
		? `/account/${parsed.section}/${parsed.rest}`
		: `/account/${parsed.section}`
}

/** Same kind of page in `targetSlug` when the path is an org resource; otherwise that organization's home. */
export function switchOrgPath(pathname: string, targetSlug: string) {
	if (!isOrganizationSlug(targetSlug)) return '/'
	const parsed = parseOrgResourcePath(pathname)
	if (!parsed) return `/@${targetSlug}`
	return orgResourcePath(targetSlug, parsed.section, parsed.rest)
}

export function orderOrganizations<T extends OrganizationSummary>(
	orgs: ReadonlyArray<T>,
) {
	return [...orgs].sort((left, right) => {
		if (left.personal !== right.personal) return left.personal ? -1 : 1
		return left.slug.localeCompare(right.slug)
	})
}

/**
 * Signup organization first, then the others. A single organization stays
 * minimal: no role label. Create and Invites always follow the organizations.
 */
export function orgSwitcherEntries(
	orgs: ReadonlyArray<OrganizationSummary>,
	inviteCount: number,
): Array<OrgSwitcherEntry> {
	const ordered = orderOrganizations(orgs)
	const showRole = ordered.length > 1
	const count = Number.isFinite(inviteCount)
		? Math.max(0, Math.floor(inviteCount))
		: 0
	return [
		...ordered.map(
			(org) =>
				({
					kind: 'org',
					org,
					showRole,
				}) satisfies OrgSwitcherEntry,
		),
		{ kind: 'create' },
		{ kind: 'invites', count },
	]
}

export function orgRoleLabel(role: OrgRole | null) {
	switch (role) {
		case 'owner':
			return 'Owner'
		case 'member':
			return 'Member'
		case 'billing':
			return 'Billing'
		case null:
			return 'Collaborator'
		default: {
			const exhaustive: never = role
			return exhaustive
		}
	}
}

export function currentSwitcherSlug(input: {
	pathname: string
	organizations: ReadonlyArray<OrganizationSummary>
	lastUsedSlug: string | null
}) {
	const fromPath = orgSlugFromPathname(input.pathname)
	if (fromPath && input.organizations.some((org) => org.slug === fromPath)) {
		return fromPath
	}
	if (
		input.lastUsedSlug &&
		input.organizations.some((org) => org.slug === input.lastUsedSlug)
	) {
		return input.lastUsedSlug
	}
	return (
		input.organizations.find((org) => org.personal)?.slug ??
		input.organizations[0]?.slug ??
		null
	)
}
