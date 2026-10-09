import {
	type ApiTokenResource,
	type ApiTokenScope,
} from '#worker/api-tokens/scopes.ts'
import { type SurfacePermission } from '#worker/authorization/authorize.ts'

export const apiOperationMethods = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
] as const

export type ApiOperationMethod = (typeof apiOperationMethods)[number]

export type ApiOperationTag = ApiTokenResource | 'search' | 'capability-proxy'

type ApiOperationBase = {
	operationId: string
	method: ApiOperationMethod
	/** OpenAPI path template, e.g. `/v1/packages/{package_id}`. */
	path: string
	tag: ApiOperationTag
}

/**
 * An operation backed by a registry capability. `operationId` is the
 * capability name, inputs are the capability's input schema (path params
 * map to same-named inputs), its org permission is the capability's
 * `orgPermission`, and the scope follows the capability's `readOnly` flag
 * unless the capability is listed in `writeScopeCapabilityNames`.
 */
export type CapabilityApiOperation = ApiOperationBase & {
	kind: 'capability'
	/** Inputs that cannot be encoded in this method's query string. */
	omitInputs?: ReadonlyArray<string>
	/** Explicit scope; defaults from the tag and the capability. */
	scope?: ApiTokenScope
}

export const nativeApiOperationIds = [
	'tokenList',
	'tokenCreate',
	'tokenGetCurrent',
	'tokenRotateCurrent',
	'tokenRevokeCurrent',
	'tokenGet',
	'tokenRotate',
	'tokenRevoke',
	'cliCredentialBootstrapRedeem',
	'capabilityProxySession',
	'capabilityProxyCall',
	'localExecutePackageGraph',
] as const

export type NativeApiOperationId = (typeof nativeApiOperationIds)[number]

/** An operation implemented directly by the Open API (not a capability). */
export type NativeApiOperation = ApiOperationBase & {
	kind: 'native'
	operationId: NativeApiOperationId
	/** `null` means any valid token may call it (it acts on itself). */
	scope: ApiTokenScope | null
	/** Org permission, published as `x-kody-permission`. */
	permission: SurfacePermission
}

export type ApiOperation = CapabilityApiOperation | NativeApiOperation

/**
 * Capabilities whose registry `readOnly` flag is true but that sign, lock, or
 * run caller-supplied queries, so an API token needs the write scope.
 */
export const writeScopeCapabilityNames: ReadonlySet<string> = new Set([
	'secretLock',
	'secretJwtSign',
	'secretProviderLock',
	'storageQuery',
])

type CapabilityRoute = [
	method: ApiOperationMethod,
	path: string,
	capabilityName: string,
	options?: Pick<CapabilityApiOperation, 'omitInputs' | 'scope'>,
]

function capabilityRoutes(
	tag: ApiOperationTag,
	routes: ReadonlyArray<CapabilityRoute>,
): Array<CapabilityApiOperation> {
	return routes.map(([method, path, operationId, options]) => ({
		kind: 'capability',
		operationId,
		method,
		path,
		tag,
		...options,
	}))
}

function nativeRoute(
	method: ApiOperationMethod,
	path: string,
	operationId: NativeApiOperationId,
	scope: ApiTokenScope | null,
	permission: SurfacePermission,
	options: Pick<NativeApiOperation, 'tag'> = { tag: 'tokens' },
): NativeApiOperation {
	return {
		kind: 'native',
		operationId,
		method,
		path,
		scope,
		permission,
		...options,
	}
}

const capabilityProxyRoute = {
	tag: 'capability-proxy',
} as const

/**
 * Every operation on the Kody Open API (`/v1`). Changes here are public API:
 * add operations freely, but never rename an operationId, change a method or
 * path, or remove an operation without a new version.
 *
 * Deliberately absent: `execute` (use MCP or local execute), secret
 * plaintext reads, inbound webhook receive, package-app HTTP/WebSocket
 * traffic, admin, and runtime-only capabilities (values, package-app fetch,
 * synthetic dispatch).
 */
export const apiOperations: ReadonlyArray<ApiOperation> = [
	...capabilityRoutes('account', [
		['GET', '/v1/me', 'metaGetCurrentUser'],
		['GET', '/v1/account/usage', 'usageGet'],
		['GET', '/v1/account/usage/trend', 'usageTrendGet'],
		['GET', '/v1/account/usage/by-package', 'usageByPackageGet'],
		['GET', '/v1/account/waiting', 'waitingSummary'],
		['GET', '/v1/account/export', 'accountExportManifest'],
		['GET', '/v1/account/export/{section}', 'accountExportSection'],
		['GET', '/v1/account/feedback', 'metaPlatformFeedbackList'],
		['GET', '/v1/account/feedback/{feedback_id}', 'metaPlatformFeedbackGet'],
		['POST', '/v1/account/feedback', 'metaPlatformFeedbackSubmit'],
		// Teams access (grants, invites, orgs, teams). Tagged account until
		// token scopes move to the org vocabulary (P4/P5).
		['GET', '/v1/access/grants', 'accessList'],
		['POST', '/v1/access/grants', 'accessGrant'],
		['POST', '/v1/access/grants/{grant_id}/revoke', 'accessRevoke'],
		['POST', '/v1/access/invites', 'inviteCreate'],
		['POST', '/v1/access/invites/accept', 'inviteAccept'],
		['POST', '/v1/access/invites/{invite_id}/revoke', 'inviteRevoke'],
		['POST', '/v1/orgs', 'orgCreate'],
		['PATCH', '/v1/orgs/members/{user_id}', 'orgMemberUpdate'],
		['DELETE', '/v1/orgs/members/{user_id}', 'orgMemberRemove'],
		['POST', '/v1/orgs/teams', 'teamCreate'],
		['POST', '/v1/orgs/teams/{team_id}/members', 'teamMemberAdd'],
		[
			'DELETE',
			'/v1/orgs/teams/{team_id}/members/{user_id}',
			'teamMemberRemove',
		],
	]),
	...capabilityRoutes('search', [
		[
			'GET',
			'/v1/search',
			'search',
			{ scope: 'search:read', omitInputs: ['memoryContext'] },
		],
	]),
	...capabilityRoutes('memories', [
		['GET', '/v1/memories', 'metaMemorySearch'],
		['POST', '/v1/memories', 'metaMemoryUpsert'],
		['POST', '/v1/memories/verify', 'metaMemoryVerify'],
		['GET', '/v1/memories/{memory_id}', 'metaMemoryGet'],
		['DELETE', '/v1/memories/{memory_id}', 'metaMemoryDelete'],
		['GET', '/v1/mcp-server-instructions', 'metaGetMcpServerInstructions'],
		['PUT', '/v1/mcp-server-instructions', 'metaSetMcpServerInstructions'],
	]),
	...capabilityRoutes('secrets', [
		['GET', '/v1/secrets', 'secretList'],
		['POST', '/v1/secrets/batch', 'secretSetMany'],
		['POST', '/v1/secrets/lock', 'secretLock'],
		['POST', '/v1/secrets/jwt', 'secretJwtSign'],
		['PUT', '/v1/secrets/{scope}/{name}', 'secretSet'],
		['DELETE', '/v1/secrets/{scope}/{name}', 'secretDelete'],
		['GET', '/v1/secret-providers', 'secretProviderList'],
		['PUT', '/v1/secret-providers/{provider}', 'secretProviderBind'],
		['DELETE', '/v1/secret-providers/{provider}', 'secretProviderUnbind'],
		['POST', '/v1/secret-providers/{provider}/lock', 'secretProviderLock'],
	]),
	...capabilityRoutes('packages', [
		['GET', '/v1/packages', 'packageList'],
		['POST', '/v1/packages', 'packageSave'],
		['GET', '/v1/packages/{package_id}', 'packageGet'],
		['PATCH', '/v1/packages/{package_id}', 'packageUpdate'],
		['DELETE', '/v1/packages/{package_id}', 'packageDelete'],
		['POST', '/v1/packages/{package_id}/git-remote', 'packageGetGitRemote'],
		[
			'POST',
			'/v1/packages/{package_id}/external-push',
			'packagePublishExternalPush',
		],
		['GET', '/v1/package-subscriptions', 'packageSubscriptionsList'],
		['GET', '/v1/package-shares', 'packageShareList'],
		['POST', '/v1/package-shares', 'packageShareInvite'],
		['POST', '/v1/package-shares/accept', 'packageShareAccept'],
		['GET', '/v1/package-shares/{grant_id}', 'packageShareInspect'],
		['POST', '/v1/package-shares/{grant_id}/revoke', 'packageShareRevoke'],
		['POST', '/v1/package-shares/{grant_id}/leave', 'packageShareLeave'],
		[
			'POST',
			'/v1/package-shares/{grant_id}/acknowledge-update',
			'packageShareAcknowledgeUpdate',
		],
	]),
	...capabilityRoutes('repos', [
		['GET', '/v1/repos', 'repoList'],
		['POST', '/v1/repos', 'repoCreate'],
		['GET', '/v1/repos/{repo_id}', 'repoGet'],
		['PATCH', '/v1/repos/{repo_id}', 'repoUpdate'],
		['DELETE', '/v1/repos/{repo_id}', 'repoDelete'],
		['POST', '/v1/repos/{repo_id}/git-remote', 'repoGetGitRemote'],
		['POST', '/v1/repos/{repo_id}/promote', 'repoPromoteToPackage'],
		['GET', '/v1/repo-publish-note', 'repoShowPublishNote'],
		['GET', '/v1/repo-sessions', 'repoListSessions'],
		['POST', '/v1/repo-sessions', 'repoOpenSession'],
		['GET', '/v1/repo-sessions/{session_id}', 'repoGetSession'],
		['DELETE', '/v1/repo-sessions/{session_id}', 'repoDiscardSession'],
		['GET', '/v1/repo-sessions/{session_id}/status', 'repoStatus'],
		['GET', '/v1/repo-sessions/{session_id}/diff', 'repoDiff'],
		['GET', '/v1/repo-sessions/{session_id}/log', 'repoLog'],
		['GET', '/v1/repo-sessions/{session_id}/tree', 'repoTree'],
		['GET', '/v1/repo-sessions/{session_id}/file', 'repoReadFile'],
		['GET', '/v1/repo-sessions/{session_id}/search', 'repoSearch'],
		['POST', '/v1/repo-sessions/{session_id}/edits', 'repoEditFiles'],
		['POST', '/v1/repo-sessions/{session_id}/patch', 'repoApplyPatch'],
		['POST', '/v1/repo-sessions/{session_id}/restore', 'repoRestore'],
		['POST', '/v1/repo-sessions/{session_id}/commits', 'repoCommit'],
		['GET', '/v1/repo-sessions/{session_id}/checks', 'repoGetCheckStatus'],
		['POST', '/v1/repo-sessions/{session_id}/checks', 'repoRunChecks'],
		['POST', '/v1/repo-sessions/{session_id}/rebase', 'repoRebaseSession'],
		['POST', '/v1/repo-sessions/{session_id}/publish', 'repoPublishSession'],
	]),
	...capabilityRoutes('jobs', [
		['GET', '/v1/jobs', 'jobList'],
		['GET', '/v1/jobs/{id}', 'jobGet'],
		['PATCH', '/v1/jobs/{id}', 'jobUpdate'],
		['DELETE', '/v1/jobs/{id}', 'jobDelete'],
		['POST', '/v1/jobs/{id}/run', 'jobRunNow'],
		['GET', '/v1/workflow-runs', 'workflowRunList'],
		['POST', '/v1/workflow-runs/{id}/cancel', 'workflowRunCancel'],
	]),
	...capabilityRoutes('webhooks', [
		['GET', '/v1/webhooks', 'webhookList'],
		['POST', '/v1/webhooks/apply', 'webhookUrlApply'],
		['POST', '/v1/webhooks/{webhookName}/url', 'webhookUrlMint'],
		['POST', '/v1/webhooks/{webhookName}/url/rotate', 'webhookUrlRotate'],
		['POST', '/v1/webhooks/{webhookName}/enable', 'webhookEnable'],
		['POST', '/v1/webhooks/{webhookName}/disable', 'webhookDisable'],
		['GET', '/v1/webhooks/{webhookName}/deliveries', 'webhookDeliveryList'],
	]),
	...capabilityRoutes('email', [
		['GET', '/v1/email/inboxes', 'emailInboxList'],
		['GET', '/v1/email/messages', 'emailMessageList'],
		['GET', '/v1/email/messages/search', 'emailMessageSearch'],
		['GET', '/v1/email/messages/{message_id}', 'emailMessageGet'],
		['DELETE', '/v1/email/messages/{message_id}', 'emailMessageDelete'],
		[
			'POST',
			'/v1/email/messages/{message_id}/classify',
			'emailMessageClassify',
		],
		['POST', '/v1/email/messages/{message_id}/reply', 'emailReply'],
		['POST', '/v1/email/send', 'emailSend'],
		['GET', '/v1/email/attachments/{attachment_id}', 'emailAttachmentGet'],
		['GET', '/v1/email/delivery-events', 'emailDeliveryEventList'],
		['GET', '/v1/email/sender-rules', 'emailSenderRuleList'],
		['POST', '/v1/email/sender-rules', 'emailSenderRuleSet'],
		['DELETE', '/v1/email/sender-rules/{rule_id}', 'emailSenderRuleDelete'],
		['GET', '/v1/email/destinations', 'emailDestinationList'],
		['POST', '/v1/email/destinations', 'emailDestinationAdd'],
		['DELETE', '/v1/email/destinations/{id}', 'emailDestinationRemove'],
		[
			'POST',
			'/v1/email/destinations/{id}/default',
			'emailDestinationSetDefault',
		],
	]),
	...capabilityRoutes('integrations', [
		['GET', '/v1/integrations', 'integrationList'],
		['GET', '/v1/integrations/{name}', 'integrationGet'],
		['PUT', '/v1/integrations/{name}', 'integrationSave'],
		['DELETE', '/v1/integrations/{name}', 'integrationDelete'],
		['POST', '/v1/integrations/{name}/lock', 'integrationLock'],
		['POST', '/v1/integrations/{name}/refresh', 'integrationTokenRefresh'],
		['GET', '/v1/oauth-apps', 'integrationOauthAppList'],
		['DELETE', '/v1/oauth-apps/{slug}', 'integrationOauthAppDelete'],
		[
			'POST',
			'/v1/oauth-apps/{slug}/rotate-credentials',
			'integrationOauthAppRotateCredentials',
		],
		['GET', '/v1/platform-apps', 'integrationPlatformAppList'],
	]),
	...capabilityRoutes('mcp-servers', [
		['GET', '/v1/mcp-servers', 'mcpServerList'],
		['POST', '/v1/mcp-servers', 'mcpServerAdd'],
		['DELETE', '/v1/mcp-servers/{server}', 'mcpServerRemove'],
		['PUT', '/v1/mcp-servers/{server}/enabled', 'mcpServerSetEnabled'],
		['POST', '/v1/mcp-servers/{server}/reconnect', 'mcpServerReconnect'],
		['POST', '/v1/mcp-servers/{server}/refresh', 'mcpServerRefresh'],
		['POST', '/v1/mcp-servers/{server}/lock', 'mcpServerLock'],
	]),
	...capabilityRoutes('runs', [
		['GET', '/v1/runs', 'runList'],
		['GET', '/v1/runs/summary', 'runSummary'],
		['POST', '/v1/runs/triage', 'runUpdateBulk'],
		['GET', '/v1/runs/{run_id}', 'runGet'],
		['PATCH', '/v1/runs/{run_id}', 'runUpdate'],
	]),
	...capabilityRoutes('storage', [
		['GET', '/v1/storage/{storage_id}/export', 'storageExport'],
		['POST', '/v1/storage/{storage_id}/query', 'storageQuery'],
	]),
	...capabilityRoutes('community', [
		['GET', '/v1/community/listings', 'communitySearch'],
		['POST', '/v1/community/listings', 'communityPublish'],
		['GET', '/v1/community/listings/{listing_id}', 'communityGet'],
		['DELETE', '/v1/community/listings/{listing_id}', 'communityUnpublish'],
		['POST', '/v1/community/listings/{listing_id}/fork', 'communityFork'],
		['POST', '/v1/community/listings/{listing_id}/rate', 'communityRate'],
		['POST', '/v1/community/listings/{listing_id}/report', 'communityReport'],
		['POST', '/v1/community/fork-adopt', 'communityForkAdopt'],
		['GET', '/v1/community/profile', 'communityProfileGet'],
		['PATCH', '/v1/community/profile', 'communityProfileUpdate'],
	]),
	nativeRoute('GET', '/v1/tokens', 'tokenList', 'tokens:read', 'none'),
	nativeRoute('POST', '/v1/tokens', 'tokenCreate', 'tokens:write', 'none'),
	...capabilityRoutes('tokens', [
		[
			'POST',
			'/v1/tokens/bootstrap',
			'cliCredentialBootstrap',
			{ scope: 'tokens:write' },
		],
	]),
	nativeRoute(
		'POST',
		'/v1/tokens/bootstrap/redeem',
		'cliCredentialBootstrapRedeem',
		null,
		'none',
	),
	nativeRoute('GET', '/v1/tokens/current', 'tokenGetCurrent', null, 'none'),
	nativeRoute(
		'POST',
		'/v1/tokens/current/rotate',
		'tokenRotateCurrent',
		null,
		'none',
	),
	nativeRoute(
		'DELETE',
		'/v1/tokens/current',
		'tokenRevokeCurrent',
		null,
		'none',
	),
	nativeRoute(
		'GET',
		'/v1/tokens/{token_id}',
		'tokenGet',
		'tokens:read',
		'none',
	),
	nativeRoute(
		'POST',
		'/v1/tokens/{token_id}/rotate',
		'tokenRotate',
		'tokens:write',
		'none',
	),
	nativeRoute(
		'DELETE',
		'/v1/tokens/{token_id}',
		'tokenRevoke',
		'tokens:write',
		'none',
	),
	nativeRoute(
		'GET',
		'/v1/capability-proxy/session',
		'capabilityProxySession',
		'local-execute',
		'org:execute',
		capabilityProxyRoute,
	),
	nativeRoute(
		'POST',
		'/v1/capability-proxy/call',
		'capabilityProxyCall',
		'local-execute',
		'org:execute',
		capabilityProxyRoute,
	),
	nativeRoute(
		'POST',
		'/v1/local-execute/package-graph',
		'localExecutePackageGraph',
		'local-execute',
		'org:execute',
		capabilityProxyRoute,
	),
]

export const apiOperationsById: ReadonlyMap<string, ApiOperation> = new Map(
	apiOperations.map((operation) => [operation.operationId, operation]),
)

export function getApiOperationPathParams(path: string) {
	return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!)
}

export function apiOperationUsesQueryInputs(method: ApiOperationMethod) {
	return method === 'GET' || method === 'DELETE'
}

/**
 * Required scope for a capability operation. `readOnly` capabilities need
 * `<tag>:read`; everything else (and `writeScopeCapabilityNames`) needs
 * `<tag>:write`.
 */
export function resolveCapabilityOperationScope(
	operation: CapabilityApiOperation,
	capability: { name: string; readOnly: boolean },
): ApiTokenScope {
	if (operation.scope) return operation.scope
	const access =
		capability.readOnly && !writeScopeCapabilityNames.has(capability.name)
			? 'read'
			: 'write'
	return `${operation.tag}:${access}` as ApiTokenScope
}

type RouteSegment =
	| { kind: 'static'; value: string }
	| { kind: 'param'; name: string }

type CompiledRoute = {
	operation: ApiOperation
	segments: ReadonlyArray<RouteSegment>
	staticCount: number
}

const compiledRoutes: ReadonlyArray<CompiledRoute> = apiOperations.map(
	(operation) => {
		const segments = operation.path
			.split('/')
			.filter(Boolean)
			.map((segment): RouteSegment => {
				const param = /^\{([^}]+)\}$/.exec(segment)
				return param
					? { kind: 'param', name: param[1]! }
					: { kind: 'static', value: segment }
			})
		return {
			operation,
			segments,
			staticCount: segments.filter((segment) => segment.kind === 'static')
				.length,
		}
	},
)

function matchRoute(route: CompiledRoute, pathSegments: ReadonlyArray<string>) {
	if (route.segments.length !== pathSegments.length) return null
	const params: Record<string, string> = {}
	for (const [index, segment] of route.segments.entries()) {
		const value = pathSegments[index]!
		if (segment.kind === 'static') {
			if (segment.value !== value) return null
			continue
		}
		let decoded: string
		try {
			decoded = decodeURIComponent(value)
		} catch {
			return null
		}
		if (!decoded) return null
		params[segment.name] = decoded
	}
	return params
}

export type ApiRouteMatch =
	| {
			kind: 'match'
			operation: ApiOperation
			pathParams: Record<string, string>
	  }
	| { kind: 'method_not_allowed'; allow: Array<ApiOperationMethod> }
	| { kind: 'not_found' }

/**
 * Match a request path. Among routes for the request method, the one with
 * the most static segments wins, so `/v1/tokens/current` beats
 * `/v1/tokens/{token_id}`.
 */
export function matchApiRoute(method: string, pathname: string): ApiRouteMatch {
	const pathSegments = pathname.split('/').filter(Boolean)
	const matches = compiledRoutes
		.map((route) => ({ route, params: matchRoute(route, pathSegments) }))
		.filter(
			(
				entry,
			): entry is { route: CompiledRoute; params: Record<string, string> } =>
				entry.params !== null,
		)
	if (matches.length === 0) return { kind: 'not_found' }
	const forMethod = matches
		.filter((entry) => entry.route.operation.method === method)
		.sort((left, right) => right.route.staticCount - left.route.staticCount)
	const best = forMethod[0]
	if (!best) {
		const allow = [
			...new Set(matches.map((entry) => entry.route.operation.method)),
		]
		return { kind: 'method_not_allowed', allow }
	}
	return {
		kind: 'match',
		operation: best.route.operation,
		pathParams: best.params,
	}
}
