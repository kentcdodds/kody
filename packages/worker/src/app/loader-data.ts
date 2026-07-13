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
	email_verified: boolean
	email_verified_at: string | null
	plan: AdminPlanName | null
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
	availablePlans: Array<AdminPlanName>
}

/**
 * POST (mutation) responses also carry the updated target user so the
 * client can patch it into an infinite-scroll list that may have scrolled
 * past the first page.
 */
export type AdminUsersMutationData = AdminUsersLoaderData & {
	updatedUser: AdminUserListItem | null
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
	| 'email_received'

export type AdminUsageEntitlementResource =
	| 'saved_packages'
	| 'scheduled_jobs'
	| 'package_services'
	| 'persistent_package_services'
	| 'repo_sessions'
	| 'email_sends_per_day'
	| 'email_receives_per_day'
	| 'stored_email_messages'
	| 'secrets'
	| 'concurrent_workflows'
	| 'storage_bytes'

export type AdminPlanName = 'partner' | 'personal' | 'pro'

export type AdminUsageRollup = {
	metric: AdminUsageMetric
	eventCount: number
	errorCount: number
	totalDurationMs: number
	totalCpuMs: number
	totalBytes: number
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

/**
 * Per-user usage drill-down shown on the admin users page. Loaded lazily
 * for one selected account at a time so admin reads stay O(1) per view
 * regardless of how many users the deployment has.
 */
export type AdminUserUsageLoaderData = {
	ok: true
	userId: number
	username: string
	plan: AdminPlanName | null
	currentMonth: string
	today: string
	currentMonthUsage: Array<AdminUsageRollup>
	monthUsage: Array<AdminUsageMonthRollup>
	entitlementConsumption: Array<AdminUsageEntitlementConsumption>
	warnings: Array<AdminUsageEntitlementConsumption>
}

export type AdminInsightsTotals = {
	users: number
	verifiedUsers: number
	savedPackages: number
	scheduledJobs: number
	enabledJobs: number
	workflowRuns: number
	activeMemories: number
	storedEmailMessages: number
	secrets: number
	activeCommunityListings: number
	passkeys: number
	oauthConnections: number
}

export type AdminInsightsSignupWeek = {
	/** UTC Monday that starts the week, for example `2026-06-29`. */
	weekStart: string
	signups: number
	/** Total registered users at the end of the week. */
	cumulativeUsers: number
}

export type AdminInsightsUsageMonth = {
	month: string
	events: Record<AdminUsageMetric, number>
	errorCount: number
}

export type AdminInsightsEmailDay = {
	day: string
	sends: number
	receives: number
}

export type AdminInsightsAuthDay = {
	day: string
	success: number
	failure: number
	rateLimited: number
}

export type AdminInsightsAuthCategory = {
	category: string
	count: number
}

export type AdminInsightsHeatmapCell = {
	/** 0 = Sunday through 6 = Saturday, matching `Date#getUTCDay`. */
	weekday: number
	/** UTC hour of day, 0-23. */
	hour: number
	count: number
}

export type AdminInsightsPlanSlice = {
	plan: string
	count: number
}

export type AdminInsightsWorkflowStatus = {
	status: string
	count: number
}

export type AdminInsightsJobHealth = {
	totalJobs: number
	enabledJobs: number
	successRuns: number
	errorRuns: number
}

export type AdminInsightsLoaderData = {
	ok: true
	generatedAt: string
	totals: AdminInsightsTotals
	signupsByWeek: Array<AdminInsightsSignupWeek>
	usageByMonth: Array<AdminInsightsUsageMonth>
	emailByDay: Array<AdminInsightsEmailDay>
	plans: Array<AdminInsightsPlanSlice>
	authByDay: Array<AdminInsightsAuthDay>
	authByCategory: Array<AdminInsightsAuthCategory>
	authHeatmap: Array<AdminInsightsHeatmapCell>
	workflowStatuses: Array<AdminInsightsWorkflowStatus>
	jobHealth: AdminInsightsJobHealth
}

export type AdminSystemEmailListItem = {
	id: string
	inbox_local_part: string
	from_address: string | null
	envelope_from: string | null
	subject: string | null
	processing_status: string
	raw_size: number
	received_at: string | null
	created_at: string
}

export type AdminSystemEmailDetail = AdminSystemEmailListItem & {
	to_addresses: Array<string>
	cc_addresses: Array<string>
	reply_to_addresses: Array<string>
	headers: Record<string, Array<string>>
	text_body: string | null
	html_body: string | null
	raw_mime: string | null
	attachments: Array<{
		id: string
		filename: string | null
		content_type: string | null
		content_id: string | null
		disposition: string | null
		size: number
		storage_kind: string
		created_at: string
	}>
}

export type AdminSystemEmailLoaderData = {
	ok: true
	ownerId: string
	systemLocals: Array<string>
	limits: {
		maxMessageBytes: number
		maxReceivesPerDay: number
		maxStoredMessages: number
		retentionDays: number
		pruneBatchSize: number
	}
	messages: Array<AdminSystemEmailListItem>
	selectedMessage: AdminSystemEmailDetail | null
	page: number
	pageSize: number
	total: number
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

export type AccountConnectionListItem = {
	provider: string
	label: string
	displayName: string | null
	createdAt: string
}

export type AccountConnectionsLoaderData = {
	ok: true
	connections: Array<AccountConnectionListItem>
	canDisconnect: boolean
	availableProviders: Array<{ id: string; label: string }>
}

export type OnboardingLoaderData = {
	ok: true
	mcpServerUrl: string
	setupPrompt: string
	hasMcpClient: boolean
	emailVerified: boolean
	needsOnboarding: boolean
}

export type AccountTwoFactorLoaderData = {
	ok: true
	enabled: boolean
}

export type AccountPasskeyListItem = {
	id: string
	deviceType: string
	backedUp: boolean
	createdAt: string
}

export type AccountPasskeysLoaderData = {
	ok: true
	passkeys: Array<AccountPasskeyListItem>
}

export type PendingVerificationLoaderData = {
	ok: true
	email: string
}

export type EmailVerificationLoaderData =
	| {
			ok: true
			kind: 'email_verify' | 'email_change'
			message: string
			ctaHref?: string
			ctaLabel?: string
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

export type AccountMcpServerListItem = {
	id: string
	name: string
	url: string
	enabled: boolean
	state: string
	connected: boolean
	toolCount: number
	authUrl: string | null
	error: string | null
	tools: Array<string>
	createdAt: string
	updatedAt: string
}

export type AccountMcpServersLoaderData = {
	ok: true
	email: string
	username: string
	servers: Array<AccountMcpServerListItem>
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

export type AccountPackageListItem = {
	id: string
	name: string
	kodyId: string
	description: string
	tags: Array<string>
	hasApp: boolean
	sourceId: string
	createdAt: string
	updatedAt: string
}

export type AccountPackageDetail = AccountPackageListItem & {
	searchText: string | null
}

export type AccountPackagesSort = 'updated' | 'created' | 'name'

export type AccountPackagesAppFilter = 'all' | 'with' | 'without'

export type AccountPackagesLoaderData = {
	ok: true
	email: string
	packages: Array<AccountPackageListItem>
	selectedPackage: AccountPackageDetail | null
	page: number
	pageSize: number
	total: number
	query: string
	appFilter: AccountPackagesAppFilter
	sort: AccountPackagesSort
}

export type AccountSecretListItem = {
	id: string
	name: string
	scope: 'package' | 'user'
	description: string
	packageId: string | null
	packageTitle: string | null
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
	packageOptions: Array<{
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
		scope: 'package' | 'session' | 'user'
		requestedHost: string
		requestedCapability: string | null
		requestedPackageId: string | null
		currentAllowedHosts: Array<string>
		currentAllowedPackages: Array<string>
	} | null
	approvalError: string | null
}

export type AuthProvidersLoaderData = {
	ok: true
	providers: Array<{ id: string; label: string }>
}

export type OAuthAuthorizeLoaderData =
	| {
			ok: true
			client: { id: string; name: string }
			scopes: Array<string>
			emailVerified: boolean | null
	  }
	| {
			ok: false
			error: string
			allowClientReset: boolean
			code?: 'email_verification_required'
	  }

export type AppLoaderData = {
	communityDetailShell?: CommunityDetailShellLoaderData
	adminUsers?: AdminUsersLoaderData
	adminRoles?: AdminRolesLoaderData
	adminCommunityReports?: AdminCommunityReportsLoaderData
	adminInvites?: AdminInvitesLoaderData
	adminInsights?: AdminInsightsLoaderData
	adminSystemEmail?: AdminSystemEmailLoaderData
	accountProfile?: AccountProfileLoaderData
	accountConnections?: AccountConnectionsLoaderData
	onboarding?: OnboardingLoaderData
	pendingVerification?: PendingVerificationLoaderData
	accountTwoFactor?: AccountTwoFactorLoaderData
	accountPasskeys?: AccountPasskeysLoaderData
	accountIntegrations?: AccountIntegrationsLoaderData
	accountMcpServers?: AccountMcpServersLoaderData
	accountRemoteConnectors?: AccountRemoteConnectorsLoaderData
	accountPackageInvocationTokens?: AccountPackageInvocationTokensLoaderData
	accountPackages?: AccountPackagesLoaderData
	accountSecrets?: AccountSecretsLoaderData
	authProviders?: AuthProvidersLoaderData
	emailVerification?: EmailVerificationLoaderData
	oauthAuthorize?: OAuthAuthorizeLoaderData
}

export function getRequestUrl(request: Request) {
	const url = new URL(request.url)
	return `${url.pathname}${url.search}${url.hash}`
}
