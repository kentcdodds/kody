import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	buildSecretHostApprovalUrl,
	buildSecretHostBulkApprovalUrlIfNeeded,
} from '#mcp/secrets/host-approval.ts'
import {
	buildBasicAuthSecretPlaceholderFromReference,
	buildIntegrationTokenPlaceholder,
	buildProviderSecretPlaceholder,
	buildSecretPlaceholder,
	decodeSecretPlaceholderPunctuation,
	formUrlEncodedTexts,
	parseBasicAuthSecretPlaceholders,
	parseIntegrationTokenPlaceholders,
	parseProviderSecretPlaceholders,
	parseSecretPlaceholders,
	replaceSecretPlaceholders,
	replaceSecretPlaceholdersInFormUrlEncoded,
	replaceSecretPlaceholdersInJson,
	replaceSecretPlaceholdersInPath,
	type ReferencedBasicAuthSecretPlaceholder,
	type ReferencedProviderSecret,
	type ReferencedSecret,
} from '#mcp/secrets/placeholders.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	fetchSecretAuthRequiredMessage,
	SecretHostNotApprovedError,
	type HostApprovalEntry,
} from '#mcp/secrets/errors.ts'
import { createUnresolvedSecretMessage } from '#mcp/secrets/unresolved-secret.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import { type ResolvedSecret } from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { SecretProviderHostDeniedError } from '#mcp/secrets/secret-providers/errors.ts'
import {
	redactEchoedSecrets,
	redactEchoedSecretsInError,
} from '#mcp/secrets/echo-redaction.ts'
import {
	createOutboundFetchDeadline,
	outboundFetchIdleTimeoutMs,
	type OutboundFetchDeadline,
	type OutboundFetchDeadlineOutcome,
} from '#mcp/outbound-fetch-deadline.ts'
import {
	assertSecretPlacement,
	SecretPlacementError,
} from '#mcp/secrets/secret-placement.ts'
import {
	grantedSecretAuthorityPackageIdSet,
	readSecretAuthorityHeader,
	resolveSecretAuthorityPackageId,
	secretAuthorityHeaderName,
	storageContextWithSecretAuthority,
} from '#mcp/secrets/secret-authority.ts'
import {
	attestedPackageStamp,
	claimedPackageStamp,
	type PackageStamp,
} from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { createMissingIntegrationAccessTokenMessage } from '#worker/integrations/credentials.ts'
import { IntegrationHostNotAllowedError } from './execute-modules/integration-host-allowlist.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	consumeDailyEntitlement,
	findCachedUserAccountByStableUserId,
} from '#worker/entitlements/service.ts'
import {
	recordUsage,
	usageAttributionFieldsFromRequest,
	type UsageEnv,
} from '#worker/usage/record-usage.ts'

type FetchGatewayProps = {
	baseUrl: string
	userId: OwnerId | null
	/**
	 * Acting user's account email when the caller context carries one.
	 * Backs the entitlement plan lookup for the outbound-fetch quota;
	 * when absent, the gateway reverse-resolves the account from the
	 * stable userId so the caller's real plan still binds.
	 */
	email: string | null
	/** The run's request; sealed secret providers inherit it. */
	request: RequestContext | null
	storageContext: StorageContext | null
	/**
	 * Bundler/host provenance ids that may be named as secret authority
	 * (run package plus static/dynamic deps). Same set as
	 * `collectPackageStorageGrantIds`. Omitted outside bundled runs.
	 */
	grantedSecretAuthorityPackageIds?: ReadonlyArray<string>
	/**
	 * CapabilityProxy / CLI `--local`: the package id the client claims, after
	 * the proxy verified `package:execute`. It binds package-scoped buckets and
	 * package rules but never skips the actor's Use (`claimed` stamp). Hosted
	 * runs leave this unset; their `storageContext.packageId` and grant set are
	 * attested.
	 */
	claimedPackageId?: string | null
	/**
	 * Per-sandbox overall outbound fetch deadline, from request start until
	 * the response body ends. Execute keeps the 60s default (30s under the
	 * 90s sandbox). Long-lived surfaces such as workflows raise this so a
	 * single slow upstream can finish under their larger budget. A stalled
	 * body also stops after {@link outboundFetchIdleTimeoutMs} without
	 * bytes. `null` disables both deadlines (caller signal only).
	 */
	outboundFetchTimeoutMs?: number | null
	/**
	 * When false, every sandbox `fetch` is rejected. Retriever runs use
	 * this to stay closed-world. Defaults to true.
	 */
	allowOutboundFetch?: boolean
}
export type { FetchGatewayProps }

/** Bindings every gateway fetch needs: secrets, quota, and usage metering. */
export type FetchGatewayEnv = Pick<
	Env,
	'APP_DB' | 'SECRET_STORE_KEY' | 'USER_METER'
> &
	UsageEnv

/**
 * Request header that disables secret placeholder resolution for one gateway
 * fetch: `x-kody-secret-resolution: off`. The header is stripped before the
 * request leaves the gateway, and any `{{secret:...}}` text passes through
 * literally. Out-of-band by design — only calling code can set a header, so
 * attacker-controlled *data* in a URL or body can never disable resolution.
 * Use it when a third party must receive literal placeholder text (for
 * example, writing config that Kody itself resolves later). `headers-only`
 * still fills header placeholders but sends the URL and body as written, for
 * a body that quotes the syntax (an issue or chat message) on a host the
 * credential allows; without it that text would be filled with the secret.
 * For merely mentioning the syntax in prose, prefer the inert
 * `{{secret:<name>}}` form, which never resolves.
 */
export const secretResolutionHeaderName = 'x-kody-secret-resolution'

/**
 * Default overall deadline for sandbox outbound `fetch` (headers and body)
 * when the caller did not pass a tighter `AbortSignal`. Kept 30s under the default execute sandbox budget
 * (90s) so a hung upstream cannot strand the whole evaluation past the host
 * deadline.
 */
export const defaultOutboundFetchTimeoutMs = 60_000

/**
 * Headroom between the executor sandbox budget and the outbound fetch
 * deadline. Matches the default execute pair (90s sandbox / 60s fetch).
 */
export const outboundFetchTimeoutHeadroomMs = 30_000

/**
 * Hung-fetch cap when the sandbox itself is unbounded. Matches the
 * workflow sandbox (270s) minus {@link outboundFetchTimeoutHeadroomMs}.
 */
export const unboundedOutboundFetchTimeoutMs = 240_000

const unboundedExecutorTimeoutMs = 2_147_483_647

/**
 * Outbound fetch deadline for a sandbox whose executor budget is
 * `executorTimeoutMs`. Short execute budgets keep the historic 60s cap;
 * workflow budgets raise it by the same 30s headroom so one slow
 * HTTP call (for example Cursor `createAgent`) can finish.
 */
export function outboundFetchTimeoutMsForExecutor(executorTimeoutMs: number) {
	if (
		!Number.isFinite(executorTimeoutMs) ||
		executorTimeoutMs >= unboundedExecutorTimeoutMs
	) {
		return unboundedOutboundFetchTimeoutMs
	}
	if (executorTimeoutMs <= 0) {
		return defaultOutboundFetchTimeoutMs
	}
	const derived = executorTimeoutMs - outboundFetchTimeoutHeadroomMs
	if (derived <= 0) {
		return Math.min(executorTimeoutMs, defaultOutboundFetchTimeoutMs)
	}
	return Math.max(defaultOutboundFetchTimeoutMs, derived)
}

export const retrieverOutboundFetchDeniedMessage =
	'Outbound fetch is not available in retriever runs.'

export class KodyFetchGateway extends WorkerEntrypoint<Env, FetchGatewayProps> {
	async fetch(request: Request) {
		return executeGatewayFetch({
			env: this.env,
			props: this.ctx.props,
			request,
			waitUntil: (promise) => this.ctx.waitUntil(promise),
			timeoutMs: this.ctx.props.outboundFetchTimeoutMs,
		})
	}
}

function resolveOutboundFetchTimeoutMs(input: {
	timeoutMs?: number | null
	propsTimeoutMs?: number | null
}): number | null {
	if (input.timeoutMs === null) return null
	if (input.timeoutMs !== undefined) return input.timeoutMs
	if (input.propsTimeoutMs === null) return null
	if (input.propsTimeoutMs !== undefined) return input.propsTimeoutMs
	return defaultOutboundFetchTimeoutMs
}

export async function executeGatewayFetch(input: {
	env: FetchGatewayEnv
	props: FetchGatewayProps
	request: Request
	globalFetch?: typeof fetch
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Override the default overall outbound deadline. `null` disables the
	 * gateway deadlines (caller signal only). Tests use short values.
	 */
	timeoutMs?: number | null
	/** Override {@link outboundFetchIdleTimeoutMs}. Tests use short values. */
	idleTimeoutMs?: number
}): Promise<Response> {
	const globalFetch = input.globalFetch ?? fetch
	const startedAtMs = Date.now()
	let response: Response | undefined
	let deadline: OutboundFetchDeadline | undefined
	let meteredEntityId = readMeteredRequestHostname(input.request.url, null)
	const timeoutMs = resolveOutboundFetchTimeoutMs({
		timeoutMs: input.timeoutMs,
		propsTimeoutMs: input.props.outboundFetchTimeoutMs,
	})

	try {
		if (input.props.allowOutboundFetch === false) {
			throw new Error(retrieverOutboundFetchDeniedMessage)
		}
		// Daily outbound-fetch quota: every sandbox fetch leaves through
		// this gateway, so the atomic counter here bounds cost abuse and
		// third-party hammering from user code. Consumed before secret
		// expansion so over-limit requests never resolve secrets.
		if (input.props.userId) {
			// Plan lookup requires the account email. Callers that cannot
			// carry one (MCP provider requests, package runtime) get it
			// reverse-resolved from the stable userId so authenticated
			// fetches count against the caller's real plan rather than
			// failing open to `max` (whose limit is still finite for
			// genuinely accountless synthetic contexts).
			const email =
				input.props.email ??
				(
					await findCachedUserAccountByStableUserId(
						input.env.APP_DB,
						input.props.userId,
					)
				)?.email ??
				null
			await consumeDailyEntitlement({
				db: input.env.APP_DB,
				env: input.env,
				userId: input.props.userId,
				email,
				resource: 'outbound_fetches_per_day',
			})
		}
		const { request: transformed, substitutedValues } =
			await expandSecretPlaceholders({
				request: input.request,
				props: input.props,
				env: input.env,
			})
		meteredEntityId = readMeteredRequestHostname(
			input.request.url,
			transformed.url,
		)
		deadline = createOutboundFetchDeadline({
			totalMs: timeoutMs,
			idleMs: input.idleTimeoutMs ?? outboundFetchIdleTimeoutMs,
			callerSignal: transformed.signal,
		})
		try {
			response = deadline.track(
				await globalFetch(
					new Request(transformed, { signal: deadline.signal }),
				),
			)
		} catch (error) {
			throw redactEchoedSecretsInError(error, substitutedValues)
		}
		return redactEchoedSecrets(response, substitutedValues)
	} catch (error) {
		deadline?.fail()
		throw error
	} finally {
		const { userId } = input.props
		if (input.props.allowOutboundFetch !== false && userId) {
			const meteredResponse = response
			// Metered when the body ends so a streamed response reports its
			// full duration, not time to headers.
			const finished: Promise<OutboundFetchDeadlineOutcome> =
				deadline?.done ?? Promise.resolve('error')
			const usagePromise = finished.then((outcome) =>
				recordUsage(input.env, {
					userId,
					eventType: 'outbound_fetch',
					entityId: meteredEntityId,
					durationMs: Date.now() - startedAtMs,
					outcome,
					...usageAttributionFieldsFromRequest(input.props.request),
					...(meteredResponse
						? readResponseContentLengthBytes(meteredResponse)
						: {}),
				}),
			)
			if (input.waitUntil) {
				input.waitUntil(usagePromise)
			} else if (!meteredResponse) {
				await usagePromise
			}
		}
	}
}

/**
 * The hostname to meter. The gateway refuses a placeholder in the URL host,
 * so the host never carries a secret and is safe to record.
 */
function readMeteredRequestHostname(
	originalUrl: string,
	transformedUrl: string | null,
) {
	const originalHostname = readRequestHostname(originalUrl)
	if (originalHostname) return originalHostname
	return transformedUrl === null ? '' : readRequestHostname(transformedUrl)
}

function readRequestHostname(url: string) {
	try {
		return new URL(url).hostname
	} catch {
		return ''
	}
}

function readResponseContentLengthBytes(
	response: Response,
): { bytes: number } | Record<string, never> {
	const raw = response.headers.get('content-length')
	if (raw == null) {
		return {}
	}
	const bytes = Number(raw)
	if (!Number.isFinite(bytes) || bytes < 0) {
		return {}
	}
	return { bytes }
}

/**
 * The outbound request with placeholders filled in its headers, URL path and
 * query, and text body, plus every credential value that went into it so the
 * response can be redacted.
 */
export async function expandSecretPlaceholders(input: {
	request: Request
	props: FetchGatewayProps
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
}): Promise<{ request: Request; substitutedValues: ReadonlyArray<string> }> {
	const headers = new Headers(input.request.headers)
	// Several APIs (GitHub most prominently) reject requests without a
	// User-Agent outright, and workerd sends none by default — bare sandbox
	// fetches hit opaque 403s. Callers that set their own keep it.
	if (!headers.has('user-agent')) {
		headers.set('user-agent', 'kody-agent/1.0')
	}
	const baseUrl = input.props.baseUrl.trim()
	if (!baseUrl) {
		throw new Error('Fetch gateway requires a non-empty baseUrl in props.')
	}
	const packageStamp = resolveGatewayPackageStamp(input.props, headers)
	const storageContext = storageContextWithSecretAuthority(
		input.props.storageContext,
		packageStamp?.packageId ?? null,
	)
	headers.delete(secretAuthorityHeaderName)
	const resolutionMode = readSecretResolutionMode(headers)
	const requestUrl = new URL(
		resolveRequestUrlForFetchGateway(input.request.url, baseUrl),
	)
	const requestBody = await readRequestBody(input.request)
	if (resolutionMode === 'off') {
		return {
			request: new Request(requestUrl, {
				method: input.request.method,
				headers,
				body: requestBodyInit(requestBody),
				redirect: input.request.redirect,
				credentials: input.request.credentials,
				mode: input.request.mode,
				cache: input.request.cache,
				integrity: input.request.integrity,
				keepalive: input.request.keepalive,
				signal: input.request.signal,
			}),
			substitutedValues: [],
		}
	}
	// `headers-only` fills header placeholders and sends the URL and body as
	// written, for a body that quotes the placeholder syntax.
	const fillsUrlAndBody = resolutionMode === 'on'
	const urlTexts = fillsUrlAndBody ? urlPlaceholderTexts(requestUrl) : []
	const bodyTexts =
		fillsUrlAndBody && requestBody ? bodyPlaceholderTexts(requestBody) : []
	const placeholderSources = [
		...Array.from(headers.values()),
		...urlTexts,
		...bodyTexts,
	]
	assertSecretPlacement({ url: requestUrl, values: placeholderSources })
	const replacements = new Map<string, string>()
	const resolvedValues = new Map<string, string>()
	const basicAuthPlaceholders = dedupeBasicAuthSecretPlaceholders(
		placeholderSources.flatMap((value) =>
			parseBasicAuthSecretPlaceholders(value),
		),
	)
	const referencedSecrets = dedupeReferencedSecrets([
		...placeholderSources.flatMap((value) => parseSecretPlaceholders(value)),
		...basicAuthPlaceholders.flatMap((placeholder) => [
			placeholder.username,
			placeholder.password,
		]),
	])
	const referencedIntegrationTokens = dedupeIntegrationTokenNames(
		placeholderSources.flatMap((value) =>
			parseIntegrationTokenPlaceholders(value),
		),
	)
	const referencedProviderSecrets = dedupeReferencedProviderSecrets(
		placeholderSources.flatMap((value) =>
			parseProviderSecretPlaceholders(value),
		),
	)
	const hasReferencedSecrets =
		referencedSecrets.length > 0 ||
		referencedIntegrationTokens.length > 0 ||
		referencedProviderSecrets.length > 0
	const callerUserId = hasReferencedSecrets
		? requireFetchUserId(input.props)
		: input.props.userId
	// The host is never a fill site, so the credential door checks each
	// credential's allowed hosts against it before resolving.
	const requestHost = normalizeHost(requestUrl.hostname)
	const settledSecretResults = await Promise.allSettled(
		referencedSecrets.map(async (referenced) => {
			if (!callerUserId) {
				throw new Error(fetchSecretAuthRequiredMessage)
			}
			const resolved = await resolveCredential({
				env: input.env as Env,
				orgId: callerUserId,
				actor: input.props.request,
				packageStamp,
				baseUrl: input.props.baseUrl,
				credential: {
					use: 'secret',
					name: referenced.name,
					scope: referenced.scope,
					storageContext,
					orgSlug: secretPageOrgSlugFromCaller(input.props),
					requestHost,
				},
			})
			if (!resolved.found || typeof resolved.value !== 'string') {
				// Missing or scope-unavailable secrets are caller-clearable
				// (wrong name/runtime). Keep them off Sentry via McpCallerError.
				throw new McpCallerError(
					await createUnresolvedSecretMessage({
						env: input.env,
						userId: callerUserId,
						name: referenced.name,
						scope: referenced.scope,
						storageContext,
						baseUrl: input.props.baseUrl,
					}),
				)
			}
			return { referenced, resolved, value: resolved.value }
		}),
	)
	const resolvedSecretResults = readSettledSecretResults({
		settled: settledSecretResults,
		props: input.props,
		storageContext,
		requestedHost: requestUrl.hostname,
	})
	const resolvedIntegrationTokens = await Promise.all(
		referencedIntegrationTokens.map(async (name) => {
			if (!callerUserId) {
				throw new Error(fetchSecretAuthRequiredMessage)
			}
			const value = await resolveCredential({
				env: input.env as Env,
				orgId: callerUserId,
				actor: input.props.request,
				packageStamp,
				baseUrl: input.props.baseUrl,
				credential: { use: 'integration-token', name, requestHost },
			}).catch((error: unknown) => {
				throw error instanceof IntegrationHostNotAllowedError
					? new SecretPlacementError(error.message, name)
					: error
			})
			if (!value) {
				throw new Error(createMissingIntegrationAccessTokenMessage(name))
			}
			return { name, value }
		}),
	)
	const resolvedProviderSecrets = await Promise.all(
		referencedProviderSecrets.map(async (referenced) => {
			const request = input.props.request
			if (!callerUserId || !request) {
				throw new Error(fetchSecretAuthRequiredMessage)
			}
			const resolved = await resolveCredential({
				env: input.env as Env,
				orgId: callerUserId,
				actor: request,
				packageStamp,
				baseUrl: input.props.baseUrl,
				credential: {
					use: 'provider-secret',
					provider: referenced.provider,
					ref: referenced.ref,
					storageContext,
					requestHost,
				},
			}).catch((error: unknown) => {
				throw error instanceof SecretProviderHostDeniedError
					? new SecretPlacementError(error.message, null)
					: error
			})
			return { referenced, resolved }
		}),
	)
	for (const { referenced, value } of resolvedSecretResults) {
		const placeholder = buildSecretPlaceholder(referenced)
		if (!replacements.has(placeholder)) {
			replacements.set(placeholder, value)
		}
		if (!resolvedValues.has(placeholder)) {
			resolvedValues.set(placeholder, value)
		}
	}
	for (const { name, value } of resolvedIntegrationTokens) {
		const placeholder = buildIntegrationTokenPlaceholder(name)
		if (!replacements.has(placeholder)) {
			replacements.set(placeholder, value)
		}
	}
	for (const { referenced, resolved } of resolvedProviderSecrets) {
		const placeholder = buildProviderSecretPlaceholder(referenced)
		if (!replacements.has(placeholder)) {
			replacements.set(placeholder, resolved.value)
		}
	}
	const encodedBasicCredentials: Array<string> = []
	for (const placeholder of basicAuthPlaceholders) {
		const renderedPlaceholder =
			buildBasicAuthSecretPlaceholderFromReference(placeholder)
		const authHeader = buildBasicAuthHeader({
			username: readResolvedSecretValue(resolvedValues, placeholder.username),
			password: readResolvedSecretValue(resolvedValues, placeholder.password),
		})
		encodedBasicCredentials.push(authHeader.slice('Basic '.length))
		for (const scheme of ['Basic', 'basic', 'BASIC']) {
			const prefixedPlaceholder = `${scheme} ${renderedPlaceholder}`
			if (!replacements.has(prefixedPlaceholder)) {
				replacements.set(prefixedPlaceholder, authHeader)
			}
		}
		if (!replacements.has(renderedPlaceholder)) {
			replacements.set(renderedPlaceholder, authHeader)
		}
	}
	for (const [key, value] of Array.from(headers.entries())) {
		headers.set(key, replaceSecretPlaceholders(value, replacements))
	}
	const nextUrl = fillsUrlAndBody
		? fillUrlPlaceholders(requestUrl, replacements)
		: requestUrl
	const fillsBody = requestBody != null && bodyTexts.some(holdsPlaceholder)
	const nextBody = fillsBody
		? fillBodyPlaceholders(requestBody, replacements)
		: requestBodyInit(requestBody)
	// A filled body has a new length; the runtime sets it from the bytes.
	if (fillsBody) headers.delete('content-length')
	const nextRedirect =
		hasReferencedSecrets && input.request.redirect === 'follow'
			? 'manual'
			: input.request.redirect
	return {
		request: new Request(nextUrl, {
			method: input.request.method,
			headers,
			body: nextBody,
			redirect: nextRedirect,
			credentials: input.request.credentials,
			mode: input.request.mode,
			cache: input.request.cache,
			integrity: input.request.integrity,
			keepalive: input.request.keepalive,
			signal: input.request.signal,
		}),
		substitutedValues: [...replacements.values(), ...encodedBasicCredentials],
	}
}

/**
 * Which package is fetching. A CapabilityProxy claim is `claimed`. Otherwise
 * the host-set run package, or a header naming a package in the run's grant
 * set, is `attested`.
 */
function resolveGatewayPackageStamp(
	props: FetchGatewayProps,
	headers: Headers,
): PackageStamp | null {
	const claimed = claimedPackageStamp(props.claimedPackageId)
	if (claimed) {
		if (props.storageContext?.packageId) {
			throw new Error(
				'Fetch gateway props cannot carry both a claimed package id and a run package id.',
			)
		}
		return claimed
	}
	const grantedPackageIds =
		grantedSecretAuthorityPackageIdSet(
			props.grantedSecretAuthorityPackageIds,
		) ?? new Set<string>()
	return attestedPackageStamp(
		resolveSecretAuthorityPackageId({
			requestedPackageId: readSecretAuthorityHeader(headers, grantedPackageIds),
			grantedPackageIds,
			runPackageId: props.storageContext?.packageId,
		}),
	)
}

/**
 * Kody runtime / sandboxed fetch may emit path-only URLs (e.g. `/`, `/core/log`).
 * Workers `Request` requires an absolute URL string; resolve against the app origin.
 */
function resolveRequestUrlForFetchGateway(url: string, baseUrl: string) {
	const trimmed = url.trim()
	if (!trimmed) {
		throw new Error('Fetch gateway received an empty request URL.')
	}
	try {
		return new URL(trimmed).toString()
	} catch {
		try {
			return new URL(trimmed, baseUrl).toString()
		} catch {
			throw new Error(
				`Fetch gateway could not resolve request URL "${trimmed}" against baseUrl.`,
			)
		}
	}
}

type MissingHostApproval = HostApprovalEntry & { scope: SecretScope }

type ResolvedSecretResult = {
	referenced: ReferencedSecret
	resolved: ResolvedSecret
	value: string
}

/**
 * Door host denials are collected into one batch message, so every missing
 * approval is listed at once. Any other failure is rethrown first.
 */
function readSettledSecretResults(input: {
	settled: Array<PromiseSettledResult<ResolvedSecretResult>>
	props: FetchGatewayProps
	storageContext: StorageContext
	requestedHost: string
}) {
	const results: Array<ResolvedSecretResult> = []
	const hostDenials: Array<SecretHostNotApprovedError> = []
	for (const entry of input.settled) {
		if (entry.status === 'fulfilled') {
			results.push(entry.value)
		} else if (entry.reason instanceof SecretHostNotApprovedError) {
			hostDenials.push(entry.reason)
		} else {
			throw entry.reason
		}
	}
	if (hostDenials.length > 0) {
		throw createHostApprovalBatchError({
			props: input.props,
			storageContext: input.storageContext,
			missingApprovals: hostDenials.map((denial) => ({
				secretName: denial.secretName,
				host: input.requestedHost,
				scope: denial.scope,
				approvalUrl: buildSecretHostApprovalUrl({
					baseUrl: input.props.baseUrl,
					name: denial.secretName,
					scope: denial.scope,
					requestedHost: input.requestedHost,
					storageContext: input.storageContext,
				}),
			})),
		})
	}
	return results
}

function createHostApprovalBatchError(input: {
	props: FetchGatewayProps
	storageContext: StorageContext
	missingApprovals: Array<MissingHostApproval>
}) {
	const { missingApprovals } = input
	const bulkScope = readBulkHostApprovalScope({
		scopes: missingApprovals.map((entry) => entry.scope),
		storageContext: input.storageContext,
	})
	const bulkApprovalUrl = bulkScope
		? buildSecretHostBulkApprovalUrlIfNeeded({
				baseUrl: input.props.baseUrl,
				names: missingApprovals.map((entry) => entry.secretName),
				hosts: missingApprovals.map((entry) => entry.host),
				scope: bulkScope.scope,
				storageContext: bulkScope.storageContext,
			})
		: null
	return new SecretPlacementError(
		createHostSecretAccessDeniedBatchMessage(
			missingApprovals.map(({ secretName, host, approvalUrl }) => ({
				secretName,
				host,
				approvalUrl,
			})),
			{ bulkApprovalUrl },
		),
		missingApprovals.length === 1
			? (missingApprovals[0]?.secretName ?? null)
			: null,
	)
}

function readBulkHostApprovalScope(input: {
	scopes: Array<SecretScope>
	storageContext: StorageContext | null
}): { scope: SecretScope; storageContext: StorageContext | null } | null {
	const { scopes } = input
	const unique = new Set(scopes)
	if (unique.size !== 1) return null
	const scope = scopes[0]
	if (!scope) return null
	switch (scope) {
		case 'user':
			return { scope, storageContext: null }
		case 'package':
		case 'session':
			return { scope, storageContext: input.storageContext }
		default: {
			const _exhaustive: never = scope
			return _exhaustive
		}
	}
}

function requireFetchUserId(props: FetchGatewayProps): OwnerId {
	if (!props.userId) {
		throw new Error(fetchSecretAuthRequiredMessage)
	}
	return props.userId
}

/**
 * Read and strip the resolution opt-out header. Unknown values fail loudly:
 * a typo like "of" silently resolving placeholders would defeat the point of
 * opting out.
 */
function readSecretResolutionMode(
	headers: Headers,
): 'on' | 'headers-only' | 'off' {
	const raw = headers.get(secretResolutionHeaderName)
	if (raw == null) return 'on'
	headers.delete(secretResolutionHeaderName)
	const value = raw.trim().toLowerCase()
	if (value === 'off') return 'off'
	if (value === 'headers-only') return 'headers-only'
	if (value === 'on') return 'on'
	throw new Error(
		`Invalid ${secretResolutionHeaderName} header value "${raw}". Use "off" to send secret placeholders literally without resolution, "headers-only" to fill header placeholders and send the URL and body as written, or omit the header to fill placeholders anywhere in the request.`,
	)
}

function dedupeReferencedProviderSecrets(
	referenced: Array<ReferencedProviderSecret>,
) {
	const deduped = new Map<string, ReferencedProviderSecret>()
	for (const entry of referenced) {
		deduped.set(buildProviderSecretPlaceholder(entry), entry)
	}
	return Array.from(deduped.values())
}

function dedupeIntegrationTokenNames(names: Array<string>) {
	return Array.from(new Set(names.filter((name) => name.trim().length > 0)))
}

function dedupeReferencedSecrets(referencedSecrets: Array<ReferencedSecret>) {
	const deduped = new Map<string, ReferencedSecret>()
	for (const referenced of referencedSecrets) {
		deduped.set(buildSecretPlaceholder(referenced), referenced)
	}
	return Array.from(deduped.values())
}

function dedupeBasicAuthSecretPlaceholders(
	placeholders: Array<ReferencedBasicAuthSecretPlaceholder>,
) {
	const deduped = new Map<string, ReferencedBasicAuthSecretPlaceholder>()
	for (const placeholder of placeholders) {
		deduped.set(
			buildBasicAuthSecretPlaceholderFromReference(placeholder),
			placeholder,
		)
	}
	return Array.from(deduped.values())
}

type GatewayRequestBody =
	| {
			kind: 'text'
			bytes: Uint8Array<ArrayBuffer>
			text: string
			format: 'form' | 'json' | 'text'
	  }
	| { kind: 'opaque'; bytes: Uint8Array<ArrayBuffer> }

/**
 * The outbound request body. `multipart/*` is always opaque: a Discord upload
 * (JSON payload plus a `.txt` attachment) is valid UTF-8, but its message
 * content is not a fill site. Other bodies that decode as UTF-8 are text the
 * gateway fills; anything else is forwarded byte for byte.
 */
async function readRequestBody(
	request: Request,
): Promise<GatewayRequestBody | null> {
	if (!shouldSendBody(request.method)) return null
	const bytes = new Uint8Array(await request.arrayBuffer())
	const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
	if (contentType.startsWith('multipart/')) return { kind: 'opaque', bytes }
	try {
		// ignoreBOM keeps a leading UTF-8 BOM in the decoded text so text
		// bodies round-trip byte for byte.
		const text = new TextDecoder('utf-8', {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes)
		return {
			kind: 'text',
			bytes,
			text,
			format: readTextBodyFormat(contentType, text),
		}
	} catch {
		return { kind: 'opaque', bytes }
	}
}

/**
 * `fetch(url, { body: JSON.stringify(...) })` without a Content-Type is sent
 * as `text/plain`, so an untyped or plain-text body that parses as JSON is
 * filled as JSON: a quote in a value must not end the string it fills.
 */
function readTextBodyFormat(contentType: string, text: string) {
	if (contentType.startsWith('application/x-www-form-urlencoded')) {
		return 'form'
	}
	const mediaType = contentType.split(';')[0]?.trim() ?? ''
	if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
		return 'json'
	}
	if ((mediaType === '' || mediaType === 'text/plain') && isJsonText(text)) {
		return 'json'
	}
	return 'text'
}

function isJsonText(text: string) {
	try {
		JSON.parse(text)
		return true
	} catch {
		return false
	}
}

/**
 * Always bytes: a string body would make the Request constructor add a
 * `text/plain` Content-Type the caller never sent.
 */
function requestBodyInit(body: GatewayRequestBody | null) {
	return body?.bytes
}

/** The text in the body a placeholder may sit in. */
function bodyPlaceholderTexts(body: GatewayRequestBody) {
	switch (body.kind) {
		case 'opaque':
			return []
		case 'text':
			return body.format === 'form'
				? formUrlEncodedTexts(body.text)
				: [body.text]
		default: {
			const exhaustive: never = body
			throw new Error(`Unhandled request body: ${String(exhaustive)}`)
		}
	}
}

function fillBodyPlaceholders(
	body: GatewayRequestBody,
	replacements: ReadonlyMap<string, string>,
) {
	if (body.kind === 'opaque') return body.bytes
	return new TextEncoder().encode(
		fillBodyText(body.text, body.format, replacements),
	)
}

function fillBodyText(
	text: string,
	format: 'form' | 'json' | 'text',
	replacements: ReadonlyMap<string, string>,
) {
	switch (format) {
		case 'form':
			return replaceSecretPlaceholdersInFormUrlEncoded(text, replacements)
		case 'json':
			return replaceSecretPlaceholdersInJson(text, replacements)
		case 'text':
			return replaceSecretPlaceholders(text, replacements)
		default: {
			const exhaustive: never = format
			throw new Error(`Unhandled body format: ${String(exhaustive)}`)
		}
	}
}

/** The URL path and each decoded query key and value. */
function urlPlaceholderTexts(url: URL) {
	return [
		decodeSecretPlaceholderPunctuation(url.pathname),
		...formUrlEncodedTexts(url.search),
	]
}

/**
 * `url` with placeholders filled in its path and query. Only the components
 * that hold one change.
 */
function fillUrlPlaceholders(
	url: URL,
	replacements: ReadonlyMap<string, string>,
) {
	const next = new URL(url)
	if (holdsPlaceholder(decodeSecretPlaceholderPunctuation(url.pathname))) {
		next.pathname = replaceSecretPlaceholdersInPath(url.pathname, replacements)
	}
	if (formUrlEncodedTexts(url.search).some(holdsPlaceholder)) {
		next.search = replaceSecretPlaceholdersInFormUrlEncoded(
			url.search.slice(1),
			replacements,
		)
	}
	return next
}

function holdsPlaceholder(value: string) {
	return (
		parseSecretPlaceholders(value).length > 0 ||
		parseBasicAuthSecretPlaceholders(value).length > 0 ||
		parseIntegrationTokenPlaceholders(value).length > 0 ||
		parseProviderSecretPlaceholders(value).length > 0
	)
}

function shouldSendBody(method: string) {
	return method !== 'GET' && method !== 'HEAD'
}

function readResolvedSecretValue(
	resolvedValues: ReadonlyMap<string, string>,
	referenced: ReferencedSecret,
) {
	const placeholder = buildSecretPlaceholder(referenced)
	const value = resolvedValues.get(placeholder)
	if (value == null) {
		throw new Error(createMissingSecretMessage(referenced.name))
	}
	return value
}

function buildBasicAuthHeader(input: { username: string; password: string }) {
	const credentials = new TextEncoder().encode(
		`${input.username}:${input.password}`,
	)
	return `Basic ${bytesToBase64(credentials)}`
}
