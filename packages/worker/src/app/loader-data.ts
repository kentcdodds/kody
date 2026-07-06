import { type PublicCommunityListing } from '#app/community-public-types.ts'
import { type PermissionString, type RoleName } from '#app/permissions.ts'

export type CommunityIndexLoaderData = {
	ok: true
	listings: Array<PublicCommunityListing>
	query: string | null
}

export type CommunityDetailLoaderData = {
	ok: true
	listing: PublicCommunityListing
	loggedIn: boolean
	forkPrompt: string
}

/** SSR-embedded shell data for client-only regions on the detail page. */
export type CommunityDetailShellLoaderData = {
	ok: true
	listingId: string
	forkPrompt: string
	loggedIn: boolean
	readmeContent: string | null
}

/**
 * Route-keyed loader payloads embedded in AppRoot props during SSR.
 * Add a key here when converting a route; handlers and route components
 * share these types with the JSON API response shapes.
 */
export type AdminUserListItem = {
	id: number
	username: string
	email: string
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

export type AdminUsersLoaderData = {
	ok: true
	users: Array<AdminUserListItem>
	page: number
	pageSize: number
	total: number
	availableRoles: Array<RoleName>
}

export type AdminRoleListItem = {
	name: string
	description: string
	permissions: Array<PermissionString>
}

export type AdminRolesLoaderData = {
	ok: true
	roles: Array<AdminRoleListItem>
}

export type AdminCommunityReportListItem = {
	id: string
	listingId: string
	listingName: string
	listingOwnerUserId: string
	reporterUserId: string
	reason: string
	status: 'open' | 'resolved' | 'dismissed'
	createdAt: string
	resolvedAt: string | null
	resolutionNote: string | null
}

export type AdminCommunityReportsLoaderData = {
	ok: true
	reports: Array<AdminCommunityReportListItem>
	statusFilter: string
}

export type AdminInviteListItem = {
	code: string
	createdBy: number | null
	createdByEmail: string | null
	note: string
	maxUses: number
	useCount: number
	expiresAt: string | null
	revokedAt: string | null
	createdAt: string
}

export type AdminInvitesLoaderData = {
	ok: true
	invites: Array<AdminInviteListItem>
}

export type AdminUsageMetric =
	| 'execute'
	| 'package_export'
	| 'job_run'
	| 'workflow_run'
	| 'service_runtime'
	| 'outbound_fetch'
	| 'email_send'

export type AdminUsageEntitlementResource =
	| 'saved_packages'
	| 'scheduled_jobs'
	| 'package_services'
	| 'persistent_package_services'
	| 'repo_sessions'
	| 'email_sends_per_day'
	| 'secrets'
	| 'concurrent_workflows'
	| 'storage_bytes'

export type AdminUsagePlanName = 'partner' | 'personal' | 'pro'

export type AdminUsageRollup = {
	metric: AdminUsageMetric
	eventCount: number
	errorCount: number
	totalDurationMs: number
	totalCpuMs: number
	totalBytes: number
}

export type AdminUsageDailyCounter = {
	resource: AdminUsageEntitlementResource
	label: string
	count: number
}

export type AdminUsageResourceCount = {
	resource: AdminUsageEntitlementResource
	label: string
	current: number
}

export type AdminUsageEntitlementConsumption = {
	resource: AdminUsageEntitlementResource
	label: string
	current: number | null
	limit: number | null
	percentOfLimit: number | null
	overEightyPercent: boolean
}

export type AdminUsageMonthRollup = {
	month: string
	usage: Array<AdminUsageRollup>
}

export type AdminUsageUserSummary = {
	id: number
	username: string
	email: string
	plan: AdminUsagePlanName | null
	currentMonthUsage: Array<AdminUsageRollup>
	todayCounters: Array<AdminUsageDailyCounter>
	resourceCounts: Array<AdminUsageResourceCount>
}

export type AdminUsageSelectedUser = AdminUsageUserSummary & {
	monthUsage: Array<AdminUsageMonthRollup>
	entitlementConsumption: Array<AdminUsageEntitlementConsumption>
	warnings: Array<AdminUsageEntitlementConsumption>
}

export type AdminUsageLoaderData = {
	ok: true
	users: Array<AdminUsageUserSummary>
	selectedUser: AdminUsageSelectedUser | null
	page: number
	pageSize: number
	total: number
	currentMonth: string
	today: string
}

export type AdminCreatedUserSetup = {
	userId: number
	email: string
	username: string
	setupLink: string
	setupTokenExpiresAt: number
}

export type AccountProfileLoaderData = {
	ok: true
	email: string
	emailVerified: boolean
	username: string
	displayName: string
}

export type EmailVerificationLoaderData =
	| {
			ok: true
			message: string
	  }
	| {
			ok: false
			error: string
	  }

export type AccountIntegrationListItem = {
	name: string
	valueName: string
	tokenUrl: string
	apiBaseUrl?: string | null
	flow: 'pkce' | 'confidential'
	clientIdValueName: string
	clientSecretSecretName?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	requiredHosts?: Array<string>
	authorization?: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator?: string | null
		extraAuthorizeParams?: Record<string, string>
	} | null
	createdAt: string
	updatedAt: string
}

export type AccountIntegrationsLoaderData = {
	ok: true
	email: string
	username: string
	integrations: Array<AccountIntegrationListItem>
}

export type AccountRemoteConnectorListItem = {
	id: string
	instanceId: string
	connectorUrl: string
	enabled: boolean
	attached: boolean
	hasSharedSecret: boolean
	sharedSecret: string
	createdAt: string
	updatedAt: string
}

export type AccountRemoteConnectorsLoaderData = {
	ok: true
	email: string
	username: string
	connectorUrlOrigin: string
	connectors: Array<AccountRemoteConnectorListItem>
}

export type AccountPackageInvocationTokenListItem = {
	id: string
	name: string
	packageIds: Array<string>
	packageKodyIds: Array<string>
	exportNames: Array<string>
	sources: Array<string>
	createdAt: string
	updatedAt: string
	lastUsedAt: string | null
	revokedAt: string | null
}

export type AccountPackageInvocationTokensLoaderData = {
	ok: true
	email: string
	username: string
	invocationUrlOrigin: string
	packages: Array<{
		id: string
		kodyId: string
		name: string
	}>
	tokens: Array<AccountPackageInvocationTokenListItem>
	selectedTokenId?: string
}

export type AccountSecretListItem = {
	id: string
	name: string
	scope: 'app' | 'user'
	description: string
	appId: string | null
	appTitle: string | null
	allowedHosts: Array<string>
	allowedCapabilities: Array<string>
	allowedPackages: Array<string>
	createdAt: string
	updatedAt: string
	ttlMs: number | null
}

export type AccountSecretDetail = AccountSecretListItem & {
	value: string
}

export type AccountSecretsLoaderData = {
	ok: true
	email: string
	apps: Array<{
		id: string
		title: string
		updatedAt: string
	}>
	packages: Array<{
		id: string
		kodyId: string
		name: string
	}>
	secrets: Array<AccountSecretListItem>
	selectedSecret: AccountSecretDetail | null
	approval: {
		name: string
		scope: 'app' | 'session' | 'user'
		requestedHost: string
		requestedCapability: string | null
		requestedPackageId: string | null
		currentAllowedHosts: Array<string>
		currentAllowedPackages: Array<string>
	} | null
	approvalError: string | null
}

export type OAuthAuthorizeLoaderData =
	| {
			ok: true
			client: { id: string; name: string }
			scopes: Array<string>
	  }
	| {
			ok: false
			error: string
			allowClientReset: boolean
	  }

export type AppLoaderData = {
	communityDetailShell?: CommunityDetailShellLoaderData
	adminUsers?: AdminUsersLoaderData
	adminRoles?: AdminRolesLoaderData
	adminCommunityReports?: AdminCommunityReportsLoaderData
	adminInvites?: AdminInvitesLoaderData
	adminUsage?: AdminUsageLoaderData
	accountProfile?: AccountProfileLoaderData
	accountIntegrations?: AccountIntegrationsLoaderData
	accountRemoteConnectors?: AccountRemoteConnectorsLoaderData
	accountPackageInvocationTokens?: AccountPackageInvocationTokensLoaderData
	accountSecrets?: AccountSecretsLoaderData
	emailVerification?: EmailVerificationLoaderData
	oauthAuthorize?: OAuthAuthorizeLoaderData
}

export function getRequestUrl(request: Request) {
	const url = new URL(request.url)
	return `${url.pathname}${url.search}${url.hash}`
}
