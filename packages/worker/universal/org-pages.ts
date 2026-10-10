import { type OrgRole } from '@kody-internal/shared/request-context.ts'

/**
 * Account sections that own organization resources. Person pages (login,
 * passkeys, email claims, experiments) stay on `/account`. Billing belongs to
 * the organization itself and has its own routes (see `parseOrgBillingPath`).
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
	'values',
	'waiting',
	'webhooks',
	'workflows',
] as const

export type OrgOwnedAccountSection = (typeof orgOwnedAccountSections)[number]

const orgOwnedSectionSet: ReadonlySet<string> = new Set(orgOwnedAccountSections)

/** Sections whose org URL is only the index. Nested paths stay on other routes. */
const exactOrgSections: ReadonlySet<string> = new Set(['packages', 'webhooks'])

export type OrganizationSummary = {
	slug: string
	displayName: string | null
	role: OrgRole | null
	/** Signup organization (org id equals the person id). Not a user-facing label. */
	personal: boolean
	/** Team-org avatar. Signup organizations use the viewer's photo instead. */
	avatarUrl?: string | null
}

export type OrgSwitcherEntry =
	| { kind: 'org'; org: OrganizationSummary; showRole: boolean }
	| { kind: 'create' }
	| { kind: 'invites'; count: number }

const slugPattern = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/

/**
 * GitLab-style separator between an organization slug and its section pages.
 * Keeps `/@owner/<kody-id>` free for canonical package URLs. Bare `-` is not a
 * valid kody.id (`kodyPackageIdPattern`), so this segment cannot collide.
 */
const orgPageSeparator = '-'

export function isOrganizationSlug(value: string) {
	return slugPattern.test(value)
}

function isOrgOwnedAccountSection(
	section: string,
): section is OrgOwnedAccountSection {
	return orgOwnedSectionSet.has(section)
}

/**
 * Packages still read the signed-in person. Other org sections read
 * `request.org.id`.
 */
export function orgSectionKeysOnPerson(
	section: OrgOwnedAccountSection,
): boolean {
	switch (section) {
		case 'packages':
			return true
		case 'activity':
		case 'connections':
		case 'email':
		case 'integrations':
		case 'jobs':
		case 'mcp-servers':
		case 'memories':
		case 'secret-providers':
		case 'secrets':
		case 'values':
		case 'waiting':
		case 'webhooks':
		case 'workflows':
			return false
		default: {
			const exhaustive: never = section
			return exhaustive
		}
	}
}

/**
 * `/account/secrets.json` and the other org-owned account JSON routes. The
 * Connections page reads `/account/connected-agents.json`;
 * `/account/connections.json` is the person's sign-in providers.
 */
export function orgOwnedAccountApiSection(
	pathname: string,
): OrgOwnedAccountSection | null {
	const match = /^\/account\/([^/.]+)\.json$/.exec(pathname)
	const name = match?.[1] ?? ''
	if (name === 'connected-agents') return 'connections'
	if (name === 'connections') return null
	return isOrgOwnedAccountSection(name) ? name : null
}

export type ParsedOrgResourcePath = {
	slug: string
	section: OrgOwnedAccountSection
	rest: string
}

/**
 * `/@acme/-/secrets/new` → slug, section, rest. Package-app and webhook
 * ingress stay at `/@owner/packages/…` and `/@owner/webhooks/…` (no `/-/`).
 */
export function parseOrgResourcePath(
	pathname: string,
): ParsedOrgResourcePath | null {
	const match = /^\/@([^/]+)\/-\/([^/]+)(\/.*)?$/.exec(pathname)
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

/**
 * `/@acme/-/billing`, `/@acme/-/billing.json`, and `/@acme/-/billing/<step>`.
 * Subscriptions are stored per organization (not per person like resource
 * sections), so billing binds team organizations as well as the signup one.
 */
export function parseOrgBillingPath(pathname: string): { slug: string } | null {
	const match = /^\/@([^/]+)\/-\/billing(?:\.json|\/[^/]+)?\/?$/.exec(pathname)
	const slug = match?.[1] ?? ''
	return isOrganizationSlug(slug) ? { slug } : null
}

export function orgBillingPath(slug: string) {
	return `/@${slug}/${orgPageSeparator}/billing`
}

/**
 * Roles whose preset includes `billing:write`. Only decides which links to
 * show; the billing routes authorize every request.
 */
export function orgRoleManagesBilling(role: OrgRole | null) {
	return role === 'owner' || role === 'billing'
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
	const base = `/@${slug}/${orgPageSeparator}/${section}`
	return suffix ? `${base}/${suffix}` : base
}

/**
 * Canonical `/@slug/-/<section>` URL for an account-shaped section path.
 * Loaders still parse the `/account/...` shape (see {@link accountAliasPath});
 * links use this so they do not point at a path that no longer has a route.
 * JSON, package detail, and person-only pages are not org section links.
 */
export function orgResourcePathForAccountPath(
	pathname: string,
	personalSlug: string,
) {
	if (!isOrganizationSlug(personalSlug)) return null
	const normalized =
		pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
	if (normalized === '/account/packages') {
		return orgResourcePath(personalSlug, 'packages')
	}
	if (
		normalized === '/account/billing' ||
		normalized === '/account/billing/success' ||
		normalized === '/account/billing/portal'
	) {
		const step = normalized.slice('/account/billing'.length).replace(/^\//, '')
		return step
			? `${orgBillingPath(personalSlug)}/${step}`
			: orgBillingPath(personalSlug)
	}
	const match = /^\/account\/([^/]+)(\/.*)?$/.exec(normalized)
	if (!match) return null
	const section = match[1] ?? ''
	if (section.endsWith('.json') || section === 'packages') return null
	if (!isOrgOwnedAccountSection(section)) return null
	const rest = (match[2] ?? '').replace(/^\//, '').replace(/\/$/, '')
	if (exactOrgSections.has(section) && rest) return null
	return orgResourcePath(personalSlug, section, rest)
}

/**
 * Rewrite an href when the person is already on an organization URL.
 * Account-shaped section paths become `/@slug/-/<section>`. Anything else
 * (APIs, person pages, package detail) stays as written.
 */
export function relocateAccountHref(href: string, currentHref: string) {
	const current = new URL(currentHref, 'http://localhost')
	const slug = orgSlugFromPathname(current.pathname)
	if (!slug) return href
	const target = new URL(href, 'http://localhost')
	const orgPath = orgResourcePathForAccountPath(target.pathname, slug)
	if (!orgPath) return href
	return `${orgPath}${target.search}${target.hash}`
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

const orgManagementSections = [
	'settings',
	'members',
	'teams',
	'grants',
	'collaborators',
] as const

export type OrgManagementSection = (typeof orgManagementSections)[number]

const orgManagementSectionSet: ReadonlySet<string> = new Set(
	orgManagementSections,
)

/**
 * `/@acme/-/settings`, `/@acme/-/members.json`, teams/grants/collaborators, and
 * mutation paths under those sections. Uses the same `/-/` separator as other
 * org pages so they cannot collide with `/@owner/<kody-id>`. Not an
 * `orgOwnedAccountSection`.
 */
export function parseOrgManagementPath(
	pathname: string,
): { slug: string; section: OrgManagementSection } | null {
	const match = new RegExp(
		`^/@([^/]+)/${orgPageSeparator}/(settings|members|teams|grants|collaborators)(?:\\.json|/[^/]+)?/?$`,
	).exec(pathname)
	if (!match) return null
	const slug = match[1] ?? ''
	const section = match[2]
	if (
		!isOrganizationSlug(slug) ||
		!section ||
		!orgManagementSectionSet.has(section)
	) {
		return null
	}
	return { slug, section: section as OrgManagementSection }
}

/**
 * Slug on an org-owned `/@slug/-/…` page (resource, billing, or management).
 * Same parse order as the server request binder. Public `/@slug` and
 * `/@owner/pkg` paths are not org-owned pages — they return null so chrome
 * does not adopt a stranger's handle.
 */
export function orgSlugFromOrgOwnedPath(pathname: string) {
	return (
		parseOrgResourcePath(pathname)?.slug ??
		parseOrgBillingPath(pathname)?.slug ??
		parseOrgManagementPath(pathname)?.slug ??
		null
	)
}

export function orgSettingsPath(slug: string) {
	return `/@${slug}/${orgPageSeparator}/settings`
}

export function orgMembersPath(slug: string) {
	return `/@${slug}/${orgPageSeparator}/members`
}

export function orgTeamsPath(slug: string) {
	return `/@${slug}/${orgPageSeparator}/teams`
}

export function orgGrantsPath(slug: string) {
	return `/@${slug}/${orgPageSeparator}/grants`
}

export function orgCollaboratorsPath(slug: string) {
	return `/@${slug}/${orgPageSeparator}/collaborators`
}

/** Same kind of page in `targetSlug` when the path is an org resource; otherwise that organization's home. */
export function switchOrgPath(pathname: string, targetSlug: string) {
	if (!isOrganizationSlug(targetSlug)) return '/'
	if (parseOrgBillingPath(pathname)) return orgBillingPath(targetSlug)
	const management = parseOrgManagementPath(pathname)
	if (management) {
		switch (management.section) {
			case 'settings':
				return orgSettingsPath(targetSlug)
			case 'members':
				return orgMembersPath(targetSlug)
			case 'teams':
				return orgTeamsPath(targetSlug)
			case 'grants':
				return orgGrantsPath(targetSlug)
			case 'collaborators':
				return orgCollaboratorsPath(targetSlug)
			default: {
				const exhaustive: never = management.section
				return exhaustive
			}
		}
	}
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
 * minimal: no role label. Create follows the organizations, then Invites
 * when any are waiting (the Organizations page lists them either way).
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
		...(count > 0 ? [{ kind: 'invites', count } as const] : []),
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

/**
 * Organizations to list for a signed-in person. A session that has not loaded
 * its memberships yet still has the signup organization under the username.
 */
export function organizationsWithSignupFallback(input: {
	organizations: ReadonlyArray<OrganizationSummary>
	username: string
}): Array<OrganizationSummary> {
	if (input.organizations.length > 0) return [...input.organizations]
	if (!input.username) return []
	return [
		{ slug: input.username, displayName: null, role: 'owner', personal: true },
	]
}

/**
 * Name and avatar every org row shows. The signup organization carries the
 * person's own name and photo; other organizations have no image yet, so
 * their avatar falls back to the initial of the name (or slug). Profile edits
 * rename the person, not the signup organization row, so the person's current
 * name wins there.
 */
export function orgIdentity(
	org: Pick<OrganizationSummary, 'slug' | 'displayName' | 'personal'> & {
		avatarUrl?: string | null
	},
	viewer: { displayName: string; avatarUrl: string | null },
) {
	const name =
		(org.personal ? viewer.displayName.trim() : '') ||
		org.displayName?.trim() ||
		null
	return {
		name: name ?? `@${org.slug}`,
		handle: `@${org.slug}`,
		hasName: name !== null,
		avatarName: name ?? org.slug,
		avatarUrl: org.personal ? viewer.avatarUrl : (org.avatarUrl ?? null),
	}
}

export function currentSwitcherSlug(input: {
	pathname: string
	organizations: ReadonlyArray<OrganizationSummary>
	lastUsedSlug: string | null
}) {
	// Org-owned `/@slug/-/…` pages already authorized the URL org. Trust that
	// slug even when the session membership list is empty or stale — otherwise
	// the switcher falls back to the personal org beside team Settings.
	const ownedPathSlug = orgSlugFromOrgOwnedPath(input.pathname)
	if (ownedPathSlug) return ownedPathSlug
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
