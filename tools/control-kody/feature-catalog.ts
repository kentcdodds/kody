export type Feature = {
	id: string
	title: string
	file: string
	paths: Array<string>
	apis: Array<string>
}

export const featuresDirRelativePath = pathToFeaturesDir()

function pathToFeaturesDir() {
	return '.agents/skills/control-kody/references/features'
}

/**
 * User-facing surfaces agents rediscover. Keep `paths` aligned with
 * `packages/worker/universal/routes.ts` HTML routes. JSON companions go in
 * `apis`.
 */
export const featureCatalog: ReadonlyArray<Feature> = [
	{
		id: 'login',
		title: 'Sign in',
		file: 'login.md',
		paths: ['/login'],
		apis: ['/auth', '/session', '/logout', '/auth/providers.json'],
	},
	{
		id: 'signup',
		title: 'Sign up and email verify',
		file: 'signup.md',
		paths: [
			'/signup',
			'/verify-email',
			'/pending-verification',
			'/verify-email-change',
		],
		apis: ['/account/resend-verification.json'],
	},
	{
		id: 'onboarding',
		title: 'Onboarding',
		file: 'onboarding.md',
		paths: [
			'/onboarding',
			'/onboarding/step-1',
			'/onboarding/step-1/:agent',
			'/onboarding/step-2',
			'/onboarding/step-2/:service',
			'/onboarding/step-3',
			'/onboarding/step-3/:agent',
		],
		apis: ['/onboarding.json', '/onboarding/checklist-dismiss.json'],
	},
	{
		id: 'password-reset',
		title: 'Password reset',
		file: 'password-reset.md',
		paths: ['/reset-password'],
		apis: [
			'/password-reset',
			'/password-reset/confirm',
			'/account/password.json',
		],
	},
	{
		id: 'two-factor',
		title: 'Two-factor auth',
		file: 'two-factor.md',
		paths: ['/account/two-factor', '/verify'],
		apis: ['/account/two-factor.json', '/verify/2fa.json'],
	},
	{
		id: 'passkeys',
		title: 'Passkeys',
		file: 'passkeys.md',
		paths: [
			'/account/passkeys',
			'/webauthn/registration',
			'/webauthn/authentication',
		],
		apis: [
			'/account/passkeys.json',
			'/webauthn/registration',
			'/webauthn/authentication',
		],
	},
	{
		id: 'account',
		title: 'Account hub',
		file: 'account.md',
		paths: ['/account', '/account/delete'],
		apis: [
			'/account/profile.json',
			'/account/profile/avatar.json',
			'/account/email-change.json',
			'/account/export.json',
			'/account/delete',
			'/account/connections.json',
		],
	},
	{
		id: 'packages',
		title: 'Packages',
		file: 'packages.md',
		paths: [
			'/account/packages',
			'/account/packages/:packageId',
			'/account/packages/:packageId/approve-publish',
			'/account/packages/:packageId/files(/*relativePath)',
			'/@:username',
			'/@:username/:kodyId',
			'/@:username/:kodyId/settings',
			'/@:username/:kodyId/approve-publish',
		],
		apis: [
			'/account/packages.json',
			'/account/packages/:packageId/approve-publish.json',
			'/account/packages/:packageId/files.json',
			'/profiles/:username/packages/:kodyId/approve-publish.json',
		],
	},
	{
		id: 'secrets',
		title: 'Secrets',
		file: 'secrets.md',
		paths: ['/account/secrets', '/connect/secrets'],
		apis: ['/account/secrets.json'],
	},
	{
		id: 'integrations',
		title: 'Integrations and OAuth connect',
		file: 'integrations.md',
		paths: ['/account/integrations', '/connect/oauth'],
		apis: ['/account/integrations.json'],
	},
	{
		id: 'mcp-servers',
		title: 'MCP servers',
		file: 'mcp-servers.md',
		paths: ['/account/mcp-servers', '/account/mcp-oauth-clients'],
		apis: ['/account/mcp-servers.json', '/account/mcp-oauth-clients.json'],
	},
	{
		id: 'jobs',
		title: 'Jobs',
		file: 'jobs.md',
		paths: ['/account/jobs'],
		apis: ['/account/jobs.json'],
	},
	{
		id: 'workflows',
		title: 'Workflows',
		file: 'workflows.md',
		paths: ['/account/workflows'],
		apis: ['/account/workflows.json'],
	},
	{
		id: 'activity',
		title: 'Activity',
		file: 'activity.md',
		paths: ['/account/activity'],
		apis: ['/account/activity.json'],
	},
	{
		id: 'waiting',
		title: 'Waiting inbox',
		file: 'waiting.md',
		paths: ['/account/waiting'],
		apis: ['/account/waiting.json'],
	},
	{
		id: 'memories',
		title: 'Memories',
		file: 'memories.md',
		paths: ['/account/memories'],
		apis: ['/account/memories.json', '/account/memories-export.json'],
	},
	{
		id: 'email',
		title: 'Email inbox',
		file: 'email.md',
		paths: ['/account/email'],
		apis: ['/account/email.json'],
	},
	{
		id: 'values',
		title: 'Values',
		file: 'values.md',
		paths: ['/account/values'],
		apis: ['/account/values.json'],
	},
	{
		id: 'billing',
		title: 'Billing and usage',
		file: 'billing.md',
		paths: ['/account/billing', '/account/usage'],
		apis: [
			'/account/billing.json',
			'/account/billing/checkout.json',
			'/account/billing/cancellation-feedback.json',
			'/account/usage.json',
		],
	},
	{
		id: 'admin',
		title: 'Admin',
		file: 'admin.md',
		paths: ['/admin'],
		apis: [
			'/admin/users.json',
			'/admin/roles.json',
			'/admin/invites.json',
			'/admin/reserved-usernames.json',
			'/admin/feature-flags.json',
			'/admin/banners.json',
			'/admin/platform-integrations.json',
			'/admin/provider-marks.json',
			'/admin/codemods.json',
			'/admin/community-reports.json',
			'/admin/insights.json',
			'/admin/platform-feedback.json',
			'/admin/system-email.json',
		],
	},
	{
		id: 'community',
		title: 'Community listings and profiles',
		file: 'community.md',
		paths: ['/community', '/@:username', '/@:username/:kodyId'],
		apis: [
			'/community.json',
			'/community/:listingId.json',
			'/community/:listingId/report.json',
			'/community/:listingId/trust.json',
			'/community/:listingId/feature.json',
			'/community/:listingId/install.json',
			'/profiles/:username.json',
			'/profiles/:username/packages/:kodyId.json',
		],
	},
	{
		id: 'marketing',
		title: 'Public marketing pages',
		file: 'marketing.md',
		paths: [
			'/',
			'/pricing',
			'/faq',
			'/support',
			'/privacy',
			'/terms',
			'/guides',
			'/blog',
			'/discord',
		],
		apis: ['/guides.json', '/blog.json', '/discord.json'],
	},
]

/** HTML prefixes that must stay mapped. JSON, assets, and well-known stay out. */
export const requiredHtmlPrefixes = [
	'/login',
	'/signup',
	'/onboarding',
	'/reset-password',
	'/verify',
	'/account',
	'/admin',
	'/connect/oauth',
	'/connect/secrets',
	'/community',
	'/@:username',
] as const

export function extractQuotedPaths(source: string) {
	const paths = new Set<string>()
	for (const match of source.matchAll(/['"`](\/[^'"`\s]*)['"`]/g)) {
		const value = match[1]
		if (value) paths.add(value)
	}
	return [...paths].toSorted()
}

export function isHtmlUserPath(routePath: string) {
	if (routePath.startsWith('/.')) return false
	if (routePath.startsWith('/integrations/')) return false
	if (routePath.startsWith('/webhooks/')) return false
	if (routePath.startsWith('/og/')) return false
	if (routePath === '/health' || routePath.startsWith('/health/')) return false
	if (routePath === '/session') return false
	if (routePath === '/code-runs.json') return false
	if (routePath === '/sentry-tunnel') return false
	if (
		routePath.endsWith('.json') ||
		routePath.endsWith('.md') ||
		routePath.endsWith('.xml') ||
		routePath.endsWith('.txt') ||
		routePath.endsWith('.png')
	) {
		return false
	}
	return true
}

export function featureCoversPath(feature: Feature, routePath: string) {
	return feature.paths.some((owned) => pathCoveredBy(owned, routePath))
}

/** Hub paths that must not swallow sibling Feature Map entries. */
export const exactOnlyOwnedPaths = ['/', '/account'] as const

export function isExactOnlyOwnedPath(owned: string) {
	return (exactOnlyOwnedPaths as ReadonlyArray<string>).includes(owned)
}

export function prefixMatches(prefix: string, routePath: string) {
	if (routePath === prefix) return true
	if (prefix === '/') return routePath === '/'
	return routePath.startsWith(`${prefix}/`)
}

export function pathCoveredBy(owned: string, routePath: string) {
	if (routePath === owned) return true
	if (isExactOnlyOwnedPath(owned)) return false
	return routePath.startsWith(`${owned}/`)
}

export function catalogCoversPath(
	catalog: ReadonlyArray<Feature>,
	routePath: string,
) {
	return catalog.some((feature) => featureCoversPath(feature, routePath))
}

export function findFeature(
	catalog: ReadonlyArray<Feature>,
	id: string,
): Feature | null {
	return catalog.find((feature) => feature.id === id) ?? null
}

export type CatalogCheckIssue = {
	kind: 'stale-path' | 'unmapped-route' | 'missing-file' | 'unknown-feature'
	id?: string
	path?: string
	file?: string
	detail: string
}

export function checkFeatureCatalog(input: {
	catalog?: ReadonlyArray<Feature>
	routeSource: string
	existingFiles: ReadonlyArray<string>
}): { ok: boolean; issues: Array<CatalogCheckIssue> } {
	const catalog = input.catalog ?? featureCatalog
	const routePaths = extractQuotedPaths(input.routeSource)
	const files = new Set(input.existingFiles)
	const issues: Array<CatalogCheckIssue> = []

	for (const feature of catalog) {
		if (!files.has(feature.file)) {
			issues.push({
				kind: 'missing-file',
				id: feature.id,
				file: feature.file,
				detail: `${feature.id} is missing ${feature.file}`,
			})
		}
		for (const owned of feature.paths) {
			const present = routePaths.includes(owned)
			if (!present) {
				issues.push({
					kind: 'stale-path',
					id: feature.id,
					path: owned,
					detail: `${feature.id} lists ${owned}, which is not in routes.ts`,
				})
			}
		}
	}

	for (const routePath of routePaths) {
		if (!isHtmlUserPath(routePath)) continue
		if (
			!requiredHtmlPrefixes.some((prefix) => prefixMatches(prefix, routePath))
		) {
			continue
		}
		if (!catalogCoversPath(catalog, routePath)) {
			issues.push({
				kind: 'unmapped-route',
				path: routePath,
				detail: `${routePath} has no Feature Map entry`,
			})
		}
	}

	return { ok: issues.length === 0, issues }
}
