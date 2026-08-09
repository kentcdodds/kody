import {
	type OnboardingFeaturedListing,
	type ProfileVisibility,
	type PublicCommunityActivityItem,
	type PublicCommunityListing,
	type PublicCommunityProfile,
	type PublicCommunityStargazer,
	type PublicProfilePackageItem,
	type ViewerListingInstall,
} from '#universal/community-public-types.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import { type AdminFeatureFlag } from '#universal/feature-flags/types.ts'
import { type OnboardingChecklistItemId } from '#universal/onboarding-checklist-types.ts'
import { type SignupMode } from '#universal/signup-mode.ts'

export type { ProfileVisibility }
export type { AdminFeatureFlag }
export type { OnboardingChecklistItemId }

export type BlogPostSummaryLoaderData = {
	slug: string
	title: string
	date: string
	description: string
	order: number
}

export type BlogLoaderData = {
	ok: true
	posts: Array<BlogPostSummaryLoaderData>
}

export type BlogPostLoaderData = {
	ok: true
	slug: string
	title: string
	date: string
	description: string
	body: string
	/** Next post in catalog order for the post foot; null when alone. */
	readNext: { slug: string; title: string } | null
}

export type GuideSummaryLoaderData = {
	slug: string
	id: string
	title: string
	summary: string
	category: 'platform' | 'provider'
	provider: string | null
	lastVerified: string | null
}

export type GuidesLoaderData = {
	ok: true
	guides: Array<GuideSummaryLoaderData>
}

export type GuideDetailLoaderData = {
	ok: true
	slug: string
	id: string
	title: string
	summary: string
	category: 'platform' | 'provider'
	provider: string | null
	lastVerified: string | null
	body: string
}

export type CommunityIndexLoaderData = {
	ok: true
	listings: Array<PublicCommunityListing>
	query: string | null
}

export type CommunityDetailLoaderData = {
	ok: true
	listing: PublicCommunityListing
	/** True when `/@owner` is publicly reachable. */
	ownerProfilePublic: boolean
	/** True when the signed-in viewer follows the listing owner. */
	viewerFollowsOwner: boolean
	/** True when the signed-in viewer owns this listing. */
	viewerIsOwner: boolean
	loggedIn: boolean
	viewerIsAdmin: boolean
	forkPrompt: string
	starredByViewer: boolean
	/** Existing fork/install for the signed-in viewer, when one exists. */
	viewerInstall: ViewerListingInstall | null
}

/** SSR-embedded shell data for client-only regions on the detail page. */
export type CommunityDetailShellLoaderData = {
	ok: true
	listingId: string
	name: string
	description: string
	forkPrompt: string
	loggedIn: boolean
	viewerIsAdmin: boolean
	trusted: boolean
	featured: boolean
	readmeContent: string | null
	starCount: number
	starredByViewer: boolean
	viewerInstall: ViewerListingInstall | null
}

export type ProfileLoaderData = {
	ok: true
	profile: PublicCommunityProfile
	packages: Array<PublicProfilePackageItem>
	activity: Array<PublicCommunityActivityItem>
	query: string | null
	isSelf: boolean
	loggedIn: boolean
	isFollowing: boolean
}

/** SSR-embedded shell data for client-only regions on the profile page. */
export type ProfileShellLoaderData = {
	ok: true
	username: string
	displayName: string
	bio: string | null
	isSelf: boolean
	loggedIn: boolean
	isFollowing: boolean
	visibility: ProfileVisibility
}

export type ProfileUnavailableLoaderData = {
	ok: false
	unavailable: true
}

export type TimelineLoaderData = {
	ok: true
	items: Array<PublicCommunityActivityItem>
}

export type AccountStarsLoaderData = {
	ok: true
	listings: Array<PublicCommunityListing>
}

export type CommunityStargazersLoaderData = {
	ok: true
	totalStars: number
	stargazers: Array<PublicCommunityStargazer>
}

/**
 * Route-keyed loader payloads embedded in AppRoot props during SSR.
 * Add a key here when converting a route; handlers and route components
 * share these types with the JSON API response shapes.
 */
export type AdminUserListItem = {
	stableUserId: string
	username: string
	email: string
	email_verified: boolean
	email_verified_at: string | null
	plan: AdminPlanName
	suspended_at: string | null
	email_outbound_paused_at: string | null
	created_at: string
	updated_at: string
	roles: Array<RoleName>
}

export type AdminUsersLoaderData = {
	ok: true
	users: Array<AdminUserListItem>
	/**
	 * Resolved independently of the filtered/paginated list so a deep link
	 * (or a selected user outside the current page) still has detail data.
	 */
	selectedUser: AdminUserListItem | null
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
	createdByStableUserId: string | null
	createdByEmail: string | null
	note: string
	maxUses: number
	useCount: number
	expiresAt: string | null
	revokedAt: string | null
	createdAt: string
	plan: AdminPlanName
}

export type AdminInvitesLoaderData = {
	ok: true
	invites: Array<AdminInviteListItem>
	availablePlans: Array<AdminPlanName>
}

export type AdminFeatureFlagsLoaderData = {
	ok: true
	featureFlags: Array<AdminFeatureFlag>
}

export type AdminCodemodListItem = {
	id: string
	description: string
}

export type AdminCodemodRunListItem = {
	id: string
	codemodId: string
	mode: string
	scopeUserId: string | null
	initiatedByUserId: string
	filtersJson: string
	status: 'running' | 'completed' | 'failed' | 'abandoned'
	revertOfRunId: string | null
	createdAt: string
	updatedAt: string
}

export type AdminCodemodRunItemListItem = {
	id: string
	runId: string
	userId: string
	packageId: string
	kodyId: string
	status: string
	beforeCommit: string | null
	afterCommit: string | null
	changedPaths: Array<string>
	findings: Array<{ path: string | null; message: string }>
	checkSummaryJson: string | null
	error: string | null
	createdAt: string
	updatedAt: string
}

export type AdminCodemodsLoaderData = {
	ok: true
	codemods: Array<AdminCodemodListItem>
	runs: Array<AdminCodemodRunListItem>
}

export type AdminCodemodRunItemsLoaderData = {
	ok: true
	run: AdminCodemodRunListItem | null
	items: Array<AdminCodemodRunItemListItem>
	nextAfterId: string | null
}

export type AdminUsageMetric =
	| 'execute'
	| 'package_export'
	| 'package_static_call'
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
	| 'execute_calls_per_day'
	| 'outbound_fetches_per_day'
	| 'job_runs_per_day'

export type AdminPlanName = 'free' | 'standard' | 'pro' | 'max'

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
	current: number
	limit: number
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
	stableUserId: string
	username: string
	plan: AdminPlanName
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
	storedEmailMessages: number | null
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

/**
 * Platform-wide outbound delivery outcomes from provider delivery events.
 * Bounce and complaint volume is the early-warning signal for shared
 * sender-domain reputation trouble (all users send from one domain).
 */
export type AdminInsightsEmailDeliveryDay = {
	day: string
	delivered: number
	deferred: number
	bounced: number
	failed: number
	rejected: number
	complained: number
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

/**
 * Ordered activation funnel. Each step counts users who ever reached it, so
 * counts are monotonically non-increasing down the list.
 */
export type AdminInsightsActivationStep = {
	step:
		| 'signed_up'
		| 'email_verified'
		| 'agent_connected'
		| 'package_forked'
		| 'package_run_succeeded'
		| 'package_activated'
	users: number
}

export type AdminInsightsActivation = {
	steps: Array<AdminInsightsActivationStep>
	/**
	 * Forks split by who caused them. Agent-driven forks are real usage but a
	 * weaker activation signal than a person choosing to install something,
	 * and rows predating the distinction are counted as unknown.
	 */
	forksByActor: { human: number; agent: number; unknown: number }
	/**
	 * Median hours from email verification to activation, over users who have
	 * activated. Null when nobody has.
	 */
	medianHoursToActivation: number | null
}

/** Content-free fanout status for per-user RunLog snapshot reads. */
export type AdminInsightsRunLogCompleteness = {
	usersAttempted: number
	usersLoaded: number
	complete: boolean
}

export type AdminInsightsDurationConsumer = {
	stableUserId: string
	username: string
	totalDurationMs: number
}

export type AdminInsightsEventCountConsumer = {
	stableUserId: string
	username: string
	eventCount: number
}

export type AdminInsightsMetricDurationConsumers = {
	metric: AdminUsageMetric
	consumers: Array<AdminInsightsDurationConsumer>
}

export type AdminInsightsEntitlementPressureResource = {
	resource: AdminUsageEntitlementResource
	label: string
	current: number
	limit: number
	percentOfLimit: number
}

export type AdminInsightsEntitlementPressureUser = {
	stableUserId: string
	username: string
	plan: AdminPlanName
	pressuredResources: Array<AdminInsightsEntitlementPressureResource>
}

export type AdminInsightsLoaderData = {
	ok: true
	generatedAt: string
	totals: AdminInsightsTotals
	signupsByWeek: Array<AdminInsightsSignupWeek>
	usageByMonth: Array<AdminInsightsUsageMonth>
	emailByDay: Array<AdminInsightsEmailDay>
	emailDeliveryByDay: Array<AdminInsightsEmailDeliveryDay>
	plans: Array<AdminInsightsPlanSlice>
	authByDay: Array<AdminInsightsAuthDay>
	authByCategory: Array<AdminInsightsAuthCategory>
	authHeatmap: Array<AdminInsightsHeatmapCell>
	workflowStatuses: Array<AdminInsightsWorkflowStatus>
	jobHealth: AdminInsightsJobHealth
	activation: AdminInsightsActivation
	runLogCompleteness: AdminInsightsRunLogCompleteness
	topRuntimeDurationConsumers: Array<AdminInsightsDurationConsumer>
	topEventCountConsumers: Array<AdminInsightsEventCountConsumer>
	topDurationConsumersByMetric: Array<AdminInsightsMetricDurationConsumers>
	entitlementPressure: Array<AdminInsightsEntitlementPressureUser>
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

export type AdminPlatformFeedbackListItem = {
	id: string
	submitter_user_id: string
	category: 'friction' | 'bug' | 'experience' | 'suggestion' | 'other'
	summary_untrusted: string
	status: 'open' | 'triaged' | 'resolved' | 'dismissed'
	reviewed_by_user_id: string | null
	reviewed_at: string | null
	created_at: string
	updated_at: string
}

export type AdminPlatformFeedbackDetail = AdminPlatformFeedbackListItem & {
	details_untrusted: string
	admin_note: string | null
	submitter: {
		user_id: string
		username: string | null
		email: string | null
	} | null
}

export type AdminPlatformFeedbackLoaderData = {
	ok: true
	feedback: Array<AdminPlatformFeedbackListItem>
	selectedFeedback: AdminPlatformFeedbackDetail | null
	content_warning: string
	page: number
	pageSize: number
	total: number
	statusFilter: AdminPlatformFeedbackListItem['status'] | null
	categoryFilter: AdminPlatformFeedbackListItem['category'] | null
}

export type AdminCreatedUserSetup = {
	stableUserId: string
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
	bio: string | null
	avatarUrl: string | null
	profileVisibility: ProfileVisibility
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
	loggedIn: boolean
	mcpServerUrl: string
	setupPrompt: string
	/** Pre-connection "is Kody for me?" prompt; usable in any tool-calling agent. */
	discoveryPrompt: string
	/** First-win send prompt: welcome email that carries the interview. */
	introEmailPrompt: string
	/** First-win remember prompt: read the reply and save memories. */
	introEmailLookupPrompt: string
	/** True when a successful email_send or stored outbound mail exists (Send done). */
	hasSentWelcomeEmail: boolean
	hasMcpClient: boolean
	emailVerified: boolean
	needsOnboarding: boolean
	/** Admin-featured trusted listings offered as one-click starter installs. */
	featuredListings: Array<OnboardingFeaturedListing>
	/** Derived progress checklist; null when logged out. */
	checklist: OnboardingChecklistLoaderData | null
}

export type OnboardingChecklistLoaderData = {
	items: Array<{
		id: OnboardingChecklistItemId
		done: boolean
	}>
	/** True when the user dismissed the checklist everywhere. */
	dismissed: boolean
}

export type AccountTwoFactorLoaderData = {
	ok: true
	enabled: boolean
}

export type AccountPasskeyListItem = {
	id: string
	name: string
	deviceType: string
	backedUp: boolean
	createdAt: string
	lastUsedAt: string | null
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
	appSlug: string
	provider: string
	appLabel: string | null
	accountLabel: string | null
	/** Empty when a provider-family prefill could not agree on token URL. */
	tokenUrl: string
	apiBaseUrl?: string | null
	/**
	 * Omitted when a provider-family prefill could not agree on flow so the
	 * connect UI keeps the query/default flow instead of inventing one.
	 */
	flow?: 'pkce' | 'confidential'
	usePkce?: boolean | null
	/** Empty when a provider-family prefill could not agree on client id. */
	clientId: string
	clientSecretSecretName?: string | null
	accessTokenSecretName: string
	refreshTokenSecretName?: string | null
	requiredHosts?: Array<string>
	tokenExchangeStyle?: 'form' | 'basic-json' | 'basic-form' | null
	authorization?: {
		authorizeUrl: string
		scopes: Array<string>
		scopeSeparator?: string | null
		extraAuthorizeParams?: Record<string, string>
	} | null
	/**
	 * True when this connection (or prefill) uses a platform built-in OAuth
	 * app: the operator owns the client registration, the shared client secret
	 * stays server-side, and the connect UI skips the client-credentials setup
	 * step entirely.
	 */
	platform?: boolean
	/** Scope menu for platform apps: the superset an operator verified. */
	platformAllowedScopes?: Array<string>
	/** Relative serving path of the operator-uploaded provider logo. */
	platformLogoPath?: string | null
	createdAt: string
	updatedAt: string
}

export type AccountOauthAppConnectionRef = {
	name: string
	accountLabel: string | null
}

/**
 * Shared OAuth app projection for the account UI. Includes secret *names* and
 * sibling connection refs only — never secret or token values.
 */
export type AccountOauthAppListItem = {
	slug: string
	provider: string
	label: string | null
	clientId: string
	clientSecretSecretName: string | null
	tokenUrl: string
	authorizeUrl: string | null
	apiBaseUrl: string | null
	flow: 'pkce' | 'confidential'
	usePkce: boolean | null
	tokenExchangeStyle: 'form' | 'basic-json' | 'basic-form' | null
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string>
	connectionCount: number
	connections: Array<AccountOauthAppConnectionRef>
	createdAt: string
	updatedAt: string
}

export type AccountIntegrationsLoaderData = {
	ok: true
	email: string
	username: string
	integrations: Array<AccountIntegrationListItem>
	apps: Array<AccountOauthAppListItem>
}

export type AccountIntegrationDetailLoaderData = {
	ok: true
	integration: AccountIntegrationListItem | null
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
	/** Canonical origin Kody registers as the OAuth client_uri. */
	oauthClientOrigin: string
	/** Exact redirect URI remote authorization servers must allow. */
	oauthCallbackUrl: string
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
		names: Array<string>
		scope: 'package' | 'session' | 'user'
		requestedHost: string
		requestedCapability: string | null
		requestedPackageId: string | null
		currentAllowedHosts: Array<string>
		currentAllowedCapabilities: Array<string>
		currentAllowedPackages: Array<string>
	} | null
	approvalError: string | null
}

export type AccountValueListItem = {
	id: string
	name: string
	description: string
	valuePreview: string
	updatedAt: string
	ttlMs: number | null
}

export type AccountValueDetail = {
	id: string
	name: string
	description: string
	value: string
	createdAt: string
	updatedAt: string
	ttlMs: number | null
	scope: 'user'
}

export type AccountValuesLoaderData = {
	ok: true
	values: Array<AccountValueListItem>
	selectedValue: AccountValueDetail | null
	selectedValueId: string | null
}

export type AccountJobOwnership = 'ad-hoc' | 'package'

/**
 * JSON-safe blob for job params (and similar free-form payloads). Remix
 * entry props require SerializableValue; `unknown` is not allowed.
 */
export type AccountLoaderJsonValue =
	| string
	| number
	| boolean
	| null
	| Array<AccountLoaderJsonValue>
	| { [key: string]: AccountLoaderJsonValue }

export type AccountJobSchedule =
	| { type: 'once'; runAt: string }
	| { type: 'interval'; every: string }
	| { type: 'cron'; expression: string }

export type AccountJobListItem = {
	id: string
	name: string
	ownership: AccountJobOwnership
	packageId: string | null
	packageName: string | null
	scheduleSummary: string
	scheduleType: AccountJobSchedule['type']
	timezone: string
	enabled: boolean
	killSwitchEnabled: boolean
	preserved: boolean
	expiresAt: string | null
	expired: boolean
	dueNow: boolean
	lastRunStatus: 'success' | 'error' | null
	nextRunAt: string
	lastRunAt: string | null
	runCount: number
	successCount: number
	errorCount: number
}

export type AccountJobRecentRun = {
	id: string
	startedAt: string
	finishedAt: string
	status: 'success' | 'error' | 'running'
	durationMs: number
	error: string | null
}

export type AccountJobDetail = AccountJobListItem & {
	params: { [key: string]: AccountLoaderJsonValue } | null
	schedule: AccountJobSchedule
	lastRunError: string | null
	lastDurationMs: number | null
	recentRuns: Array<AccountJobRecentRun>
	storageId: string
	sourceId: string
	publishedCommit: string | null
	createdAt: string
	updatedAt: string
}

export type AccountJobsAlarm = {
	bindingAvailable: boolean
	status: string
	storedUserId: string | null
	alarmScheduledFor: string | null
	nextRunnableJobId: string | null
	nextRunnableRunAt: string | null
	alarmInSync: boolean | null
}

export type AccountJobsLoaderData = {
	ok: true
	jobs: Array<AccountJobListItem>
	selectedJob: AccountJobDetail | null
	selectedJobId: string | null
	alarm?: AccountJobsAlarm
	retention: {
		successOnceDays: number
		failedOrNeverRanOnceDays: number
		disabledRecurringDays: number
		defaults: {
			successOnce: number
			failedOrNeverRanOnce: number
			disabledRecurring: number
		}
	}
}

export type AccountActivityStatusFilter = 'error' | 'all' | 'running'

export type AccountActivitySurfaceFilter =
	| 'all'
	| 'execute'
	| 'export'
	| 'subscription'
	| 'app_fetch'
	| 'app_realtime'
	| 'service'
	| 'job'
	| 'workflow'
	| 'retriever'
	| 'webhook'

export type AccountActivityTriageFilter =
	| 'open'
	| 'ignored'
	| 'resolved'
	| 'all'

export type AccountActivityRunListItem = {
	id: string
	surface: Exclude<AccountActivitySurfaceFilter, 'all'>
	status: 'running' | 'success' | 'error'
	name: string | null
	startedAt: string
	finishedAt: string | null
	durationMs: number | null
	errorName: string | null
	errorMessage: string | null
	errorTriage: 'ignored' | 'resolved' | null
	packageId: string | null
	jobId: string | null
	logCount: number
}

export type AccountActivityRunLog = {
	sequence: number
	level: 'debug' | 'info' | 'log' | 'warn' | 'error'
	message: string
	fields: { [key: string]: AccountLoaderJsonValue } | null
}

export type AccountActivityRunDetail = AccountActivityRunListItem & {
	kodyId: string | null
	sourceId: string | null
	publishedCommit: string | null
	storageId: string | null
	workflowId: string | null
	invocationId: string | null
	sessionId: string | null
	idempotencyKey: string | null
	parentRunId: string | null
	triageNote: string | null
	triagedAt: string | null
	triagedBy: string | null
	metadata: { [key: string]: AccountLoaderJsonValue }
	logs: Array<AccountActivityRunLog>
}

export type AccountActivitySummary = {
	since: string
	total: number
	errors: number
	ignored: number
	resolved: number
	running: number
}

export type AccountActivityLoaderData = {
	ok: true
	statusFilter: AccountActivityStatusFilter
	surfaceFilter: AccountActivitySurfaceFilter
	triageFilter: AccountActivityTriageFilter
	summary: AccountActivitySummary
	runs: Array<AccountActivityRunListItem>
	nextCursor: string | null
	selectedRun: AccountActivityRunDetail | null
	selectedRunId: string | null
	retentionDays: number
}

export type AccountMemoryStatus = 'active' | 'archived' | 'deleted'

export type AccountMemoryListItem = {
	id: string
	subject: string
	category: string | null
	status: AccountMemoryStatus
	tags: Array<string>
	summary: string
	updatedAt: string
}

export type AccountMemoryDetail = AccountMemoryListItem & {
	details: string
	sourceUris: Array<string>
	dedupeKey: string | null
	createdAt: string
	lastAccessedAt: string | null
	deletedAt: string | null
}

export type AccountMemoriesLoaderData = {
	ok: true
	email: string
	username: string
	memories: Array<AccountMemoryListItem>
	selectedMemory: AccountMemoryDetail | null
	query: string
	includeDeleted: boolean
}

export type AccountEmailUsageEntry = {
	count: number
	limit: number
}

export type AccountEmailUsage = {
	plan: AdminPlanName
	day: string
	stored_messages: AccountEmailUsageEntry
	sends_today: AccountEmailUsageEntry
	receives_today: AccountEmailUsageEntry
	max_message_bytes: number
}

export type AccountEmailInboxAddress = {
	id: string
	address: string
	enabled: boolean
	created_at: string
}

export type AccountEmailInbox = {
	id: string
	name: string
	description: string
	enabled: boolean
	addresses: Array<AccountEmailInboxAddress>
	created_at: string
	updated_at: string
}

export type AccountEmailMessageListItem = {
	id: string
	direction: 'inbound' | 'outbound'
	inbox_id: string | null
	thread_id: string | null
	from_address: string | null
	envelope_from: string | null
	to_addresses: Array<string>
	subject: string | null
	message_id_header: string | null
	processing_status: string
	classification: 'accepted' | 'quarantined'
	classification_reason: string | null
	provider_message_id: string | null
	delivery_status: string | null
	delivery_status_at: string | null
	error: string | null
	received_at: string | null
	sent_at: string | null
	created_at: string
	updated_at: string
}

export type AccountEmailAttachment = {
	id: string
	filename: string | null
	content_type: string | null
	content_id: string | null
	disposition: string | null
	size: number | null
	storage_kind: string
	storage_key: string | null
	created_at: string
}

export type AccountEmailDeliveryEvent = {
	id: string
	event_type: string
	provider: string | null
	provider_message_id: string | null
	provider_event_id: string | null
	detail_json: string
	created_at: string
}

export type AccountEmailMessageDetail = AccountEmailMessageListItem & {
	cc_addresses: Array<string>
	bcc_addresses: Array<string>
	reply_to_addresses: Array<string>
	in_reply_to_header: string | null
	references: Array<string>
	headers: { [key: string]: AccountLoaderJsonValue } | null
	auth_results: string | null
	text_body: string | null
	html_body: string | null
	raw_size: number | null
	attachments: Array<AccountEmailAttachment>
	delivery_events: Array<AccountEmailDeliveryEvent>
}

export type AccountEmailLoaderData = {
	ok: true
	emailVerified: boolean
	email: string
	username: string
	inboxAddress: string | null
	verificationMessage: string | null
	inboxes: Array<AccountEmailInbox>
	messages: Array<AccountEmailMessageListItem>
	selectedMessage: AccountEmailMessageDetail | null
	usage: AccountEmailUsage | null
	page: number
	pageSize: number
	total: number
	query: string
	/** `null` means no classification filter (all messages). */
	classification: 'accepted' | 'quarantined' | null
}

export type AuthProvidersLoaderData = {
	ok: true
	providers: Array<{ id: string; label: string }>
	signupMode: SignupMode
	turnstileSiteKey: string | null
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
	blog?: BlogLoaderData
	blogPost?: BlogPostLoaderData
	guides?: GuidesLoaderData
	guideDetail?: GuideDetailLoaderData
	communityDetailShell?: CommunityDetailShellLoaderData
	profileShell?: ProfileShellLoaderData | ProfileUnavailableLoaderData
	timeline?: TimelineLoaderData
	accountStars?: AccountStarsLoaderData
	adminUsers?: AdminUsersLoaderData
	adminRoles?: AdminRolesLoaderData
	adminCommunityReports?: AdminCommunityReportsLoaderData
	adminInvites?: AdminInvitesLoaderData
	adminFeatureFlags?: AdminFeatureFlagsLoaderData
	adminCodemods?: AdminCodemodsLoaderData
	adminInsights?: AdminInsightsLoaderData
	adminPlatformFeedback?: AdminPlatformFeedbackLoaderData
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
	accountValues?: AccountValuesLoaderData
	accountJobs?: AccountJobsLoaderData
	accountActivity?: AccountActivityLoaderData
	accountMemories?: AccountMemoriesLoaderData
	accountEmail?: AccountEmailLoaderData
	authProviders?: AuthProvidersLoaderData
	emailVerification?: EmailVerificationLoaderData
	oauthAuthorize?: OAuthAuthorizeLoaderData
	accountBilling?: AccountBillingLoaderData
	accountUsage?: AccountUsageLoaderData
}

export type AccountBillingLoaderData = {
	ok: true
	configured: boolean
	manualPlan: AdminPlanName
	stripePlan: AdminPlanName | null
	effectivePlan: AdminPlanName
	hasStripeCustomer: boolean
	cancelAt: string | null
	/** Stripe subscription status from on-page refresh; null if unknown/unavailable. */
	subscriptionStatus: string | null
	purchasablePlans: Array<'standard' | 'pro'>
	/** Deep link to the account usage page (limits / consumption). */
	usageHref: '/account/usage'
	error?: string
}

export type AccountUsageEntitlementConsumption = {
	resource: string
	label: string
	group: 'daily' | 'counts' | 'storage' | 'limits'
	kind: 'counter' | 'per_unit_max'
	whatCounts: string
	howToReduce: string
	current: number
	limit: number
	percentOfLimit: number | null
	overEightyPercent: boolean
}

export type AccountUsageLoaderData = {
	ok: true
	plan: AdminPlanName
	manualPlan: AdminPlanName
	stripePlan: AdminPlanName | null
	today: string
	entitlementConsumption: Array<AccountUsageEntitlementConsumption>
	warnings: Array<AccountUsageEntitlementConsumption>
}
