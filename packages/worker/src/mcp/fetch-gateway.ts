import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { buildSecretHostApprovalUrl } from '#mcp/secrets/host-approval.ts'
import {
	buildBasicAuthSecretPlaceholderFromReference,
	buildSecretPlaceholder,
	parseBasicAuthSecretPlaceholders,
	parseBasicAuthSecretPlaceholdersFromFormUrlEncoded,
	parseSecretPlaceholders,
	parseSecretPlaceholdersFromFormUrlEncoded,
	replaceSecretPlaceholders,
	replaceSecretPlaceholdersInFormUrlEncoded,
	type ReferencedBasicAuthSecretPlaceholder,
	type ReferencedSecret,
} from '#mcp/secrets/placeholders.ts'
import {
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	fetchSecretAuthRequiredMessage,
} from '#mcp/secrets/errors.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import { resolveSecret, type ResolvedSecret } from '#mcp/secrets/service.ts'
import { assertPackageCanAccessResolvedSecret } from '#mcp/secrets/package-access.ts'
import { type StorageContext } from '#mcp/storage.ts'
import {
	consumeDailyEntitlement,
	findCachedUserAccountByStableUserId,
} from '#worker/entitlements/service.ts'
import { recordUsage, type UsageEnv } from '#worker/usage/record-usage.ts'

type FetchGatewayProps = {
	baseUrl: string
	userId: string | null
	/**
	 * Acting user's account email when the caller context carries one.
	 * Backs the entitlement plan lookup for the outbound-fetch quota;
	 * when absent, the gateway reverse-resolves the account from the
	 * stable userId so the caller's real plan still binds.
	 */
	email: string | null
	storageContext: StorageContext | null
}
export type { FetchGatewayProps }

/**
 * Request header that disables secret placeholder resolution for one gateway
 * fetch: `x-kody-secret-resolution: off`. The header is stripped before the
 * request leaves the gateway, and any `{{secret:...}}` text passes through
 * literally. Out-of-band by design — only calling code can set a header, so
 * attacker-controlled *data* in a URL or body can never disable resolution.
 * Use it when a third party must receive literal placeholder text (for
 * example, writing config that Kody itself resolves later). For merely
 * mentioning the syntax in prose, prefer the inert `{{secret:<name>}}` form
 * instead, which never resolves anywhere.
 */
export const secretResolutionHeaderName = 'x-kody-secret-resolution'

/**
 * Default deadline for sandbox outbound `fetch` when the caller did not pass
 * a tighter `AbortSignal`. Kept under the execute sandbox budget (90s) so a
 * hung upstream cannot strand the whole evaluation past the host deadline.
 */
export const defaultOutboundFetchTimeoutMs = 60_000

export class KodyFetchGateway extends WorkerEntrypoint<Env, FetchGatewayProps> {
	async fetch(request: Request) {
		return executeGatewayFetch({
			env: this.env,
			props: this.ctx.props,
			request,
			waitUntil: (promise) => this.ctx.waitUntil(promise),
		})
	}
}

function applyOutboundFetchTimeout(
	request: Request,
	timeoutMs: number,
): Request {
	const timeoutSignal = AbortSignal.timeout(timeoutMs)
	const existing = request.signal
	const signal =
		existing && typeof AbortSignal.any === 'function'
			? AbortSignal.any([existing, timeoutSignal])
			: timeoutSignal
	return new Request(request, { signal })
}

export async function executeGatewayFetch(input: {
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'> & UsageEnv
	props: FetchGatewayProps
	request: Request
	globalFetch?: typeof fetch
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Override the default outbound deadline. `null` disables the gateway
	 * timeout (caller signal only). Tests use short values.
	 */
	timeoutMs?: number | null
}): Promise<Response> {
	const globalFetch = input.globalFetch ?? fetch
	const startedAtMs = Date.now()
	let outcome: 'success' | 'error' = 'success'
	let response: Response | undefined
	let meteredEntityId = readMeteredRequestHostname(input.request.url, null)
	const timeoutMs =
		input.timeoutMs === null
			? null
			: (input.timeoutMs ?? defaultOutboundFetchTimeoutMs)

	try {
		// Daily outbound-fetch quota: every sandbox fetch leaves through
		// this gateway, so the atomic counter here bounds cost abuse and
		// third-party hammering from user code. Consumed before secret
		// expansion so over-limit requests never resolve secrets.
		if (input.props.userId) {
			// Plan lookup requires the account email. Callers that cannot
			// carry one (OpenAPI provider requests, package runtime) get it
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
				userId: input.props.userId,
				email,
				resource: 'outbound_fetches_per_day',
			})
		}
		const transformed = await expandSecretPlaceholders({
			request: input.request,
			props: input.props,
			env: input.env,
		})
		meteredEntityId = readMeteredRequestHostname(
			input.request.url,
			transformed.url,
		)
		const outbound =
			timeoutMs == null
				? transformed
				: applyOutboundFetchTimeout(transformed, timeoutMs)
		response = await globalFetch(outbound)
		return response
	} catch (error) {
		outcome = 'error'
		throw error
	} finally {
		if (input.props.userId) {
			const usageEvent = {
				userId: input.props.userId,
				eventType: 'outbound_fetch' as const,
				entityId: meteredEntityId,
				durationMs: Date.now() - startedAtMs,
				outcome,
				...(response ? readResponseContentLengthBytes(response) : {}),
			}
			const usagePromise = recordUsage(input.env, usageEvent)
			if (input.waitUntil) {
				input.waitUntil(usagePromise)
			} else {
				await usagePromise
			}
		}
	}
}

/**
 * Resolve the hostname to meter without ever leaking expanded secret values.
 * A hostname parsed from the original request URL is always literal (secret
 * placeholders contain `:`, which cannot appear in a parsed hostname). When
 * the original URL has no parseable host, the transformed URL's host is only
 * safe when no placeholder could have expanded into it.
 */
function readMeteredRequestHostname(
	originalUrl: string,
	transformedUrl: string | null,
) {
	const originalHostname = readRequestHostname(originalUrl)
	if (originalHostname) return originalHostname
	if (parseSecretPlaceholders(originalUrl).length > 0) return ''
	if (parseBasicAuthSecretPlaceholders(originalUrl).length > 0) return ''
	if (transformedUrl === null) return ''
	return readRequestHostname(transformedUrl)
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

export async function expandSecretPlaceholders(input: {
	request: Request
	props: FetchGatewayProps
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
}) {
	const headers = new Headers(input.request.headers)
	const baseUrl = input.props.baseUrl.trim()
	if (!baseUrl) {
		throw new Error('Fetch gateway requires a non-empty baseUrl in props.')
	}
	const requestBody = await readRequestBody(input.request)
	if (readSecretResolutionMode(headers) === 'off') {
		return new Request(
			resolveRequestUrlForFetchGateway(input.request.url, baseUrl),
			{
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
			},
		)
	}
	const resolvedSecrets: Array<{
		referenced: ReferencedSecret
		resolved: ResolvedSecret
	}> = []
	const replacements = new Map<string, string>()
	const resolvedValues = new Map<string, string>()
	const basicAuthPlaceholders = dedupeBasicAuthSecretPlaceholders([
		...collectReferencedBasicAuthSecretPlaceholders([
			input.request.url,
			...Array.from(headers.values()),
		]),
		...collectReferencedBasicAuthSecretPlaceholdersFromRequestBody(
			headers,
			requestBody,
		),
	])
	const referencedSecrets = dedupeReferencedSecrets([
		...collectReferencedSecrets([
			input.request.url,
			...Array.from(headers.values()),
		]),
		...collectReferencedSecretsFromRequestBody(headers, requestBody),
		...basicAuthPlaceholders.flatMap((placeholder) => [
			placeholder.username,
			placeholder.password,
		]),
	])
	const hasReferencedSecrets = referencedSecrets.length > 0
	if (hasReferencedSecrets) {
		ensureFetchAllowed(input.props)
	}
	const resolvedSecretResults = await Promise.all(
		referencedSecrets.map(async (referenced) => {
			const resolved = await resolveSecret({
				env: input.env,
				userId: input.props.userId!,
				name: referenced.name,
				scope: referenced.scope,
				storageContext: input.props.storageContext,
			})
			if (!resolved.found || typeof resolved.value !== 'string') {
				throw new Error(createMissingSecretMessage(referenced.name))
			}
			await assertPackageCanAccessResolvedSecret({
				env: input.env,
				baseUrl: input.props.baseUrl,
				userId: input.props.userId!,
				storageContext: input.props.storageContext,
				secretName: referenced.name,
				resolved,
			})
			return { referenced, resolved, value: resolved.value }
		}),
	)
	for (const { referenced, resolved, value } of resolvedSecretResults) {
		const placeholder = buildSecretPlaceholder(referenced)
		if (!replacements.has(placeholder)) {
			replacements.set(placeholder, value)
		}
		if (!resolvedValues.has(placeholder)) {
			resolvedValues.set(placeholder, value)
		}
		resolvedSecrets.push({ referenced, resolved })
	}
	for (const placeholder of basicAuthPlaceholders) {
		const renderedPlaceholder =
			buildBasicAuthSecretPlaceholderFromReference(placeholder)
		const authHeader = buildBasicAuthHeader({
			username: readResolvedSecretValue(resolvedValues, placeholder.username),
			password: readResolvedSecretValue(resolvedValues, placeholder.password),
		})
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
	let requestedHost = ''
	if (hasReferencedSecrets) {
		const nextUrl = resolveRequestUrlForFetchGateway(
			replaceSecretPlaceholders(input.request.url, replacements),
			baseUrl,
		)
		requestedHost = readRequestedHost(nextUrl)
		if (!requestedHost) {
			throw new Error(
				'Unable to resolve the request host after secret expansion.',
			)
		}
		const normalizedHost = normalizeHost(requestedHost)
		const missingApprovals = await collectHostApprovalEntries({
			props: input.props,
			requestedHost,
			normalizedHost,
			resolvedSecrets,
		})
		if (missingApprovals.length > 0) {
			throw new Error(
				createHostSecretAccessDeniedBatchMessage(missingApprovals),
			)
		}
	}
	const nextUrl = resolveRequestUrlForFetchGateway(
		replaceSecretPlaceholders(input.request.url, replacements),
		baseUrl,
	)
	for (const [key, value] of Array.from(headers.entries())) {
		headers.set(key, replaceSecretPlaceholders(value, replacements))
	}
	const nextBody =
		requestBody == null
			? undefined
			: requestBody.kind === 'binary'
				? requestBody.bytes
				: replaceSecretPlaceholdersInRequestBody(
						headers,
						requestBody.text,
						replacements,
					)
	const nextRedirect =
		hasReferencedSecrets && input.request.redirect === 'follow'
			? 'manual'
			: input.request.redirect
	return new Request(nextUrl, {
		method: input.request.method,
		headers,
		body: shouldSendBody(input.request.method) ? nextBody : undefined,
		redirect: nextRedirect,
		credentials: input.request.credentials,
		mode: input.request.mode,
		cache: input.request.cache,
		integrity: input.request.integrity,
		keepalive: input.request.keepalive,
		signal: input.request.signal,
	})
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

async function collectHostApprovalEntries(input: {
	props: FetchGatewayProps
	requestedHost: string
	normalizedHost: string
	resolvedSecrets: Array<{
		referenced: ReferencedSecret
		resolved: ResolvedSecret
	}>
}) {
	const entries = await Promise.all(
		input.resolvedSecrets.map(async ({ referenced, resolved }) => {
			const allowedForHost =
				resolved.allowedHosts.length > 0 &&
				resolved.allowedHosts.includes(input.normalizedHost)
			if (allowedForHost) return null
			const approvalUrl = buildSecretHostApprovalUrl({
				baseUrl: input.props.baseUrl,
				name: referenced.name,
				scope: resolved.scope ?? referenced.scope ?? 'user',
				requestedHost: input.requestedHost,
				storageContext: input.props.storageContext,
			})
			return {
				secretName: referenced.name,
				host: input.requestedHost,
				approvalUrl,
			}
		}),
	)
	return entries.filter(
		(entry): entry is NonNullable<typeof entry> => entry != null,
	)
}

function readRequestedHost(url: string) {
	return new URL(url).hostname
}

function ensureFetchAllowed(props: FetchGatewayProps) {
	if (!props.userId) {
		throw new Error(fetchSecretAuthRequiredMessage)
	}
}

/**
 * Read and strip the resolution opt-out header. Unknown values fail loudly:
 * a typo like "of" silently resolving placeholders would defeat the point of
 * opting out.
 */
function readSecretResolutionMode(headers: Headers): 'on' | 'off' {
	const raw = headers.get(secretResolutionHeaderName)
	if (raw == null) return 'on'
	headers.delete(secretResolutionHeaderName)
	const value = raw.trim().toLowerCase()
	if (value === 'off') return 'off'
	if (value === 'on') return 'on'
	throw new Error(
		`Invalid ${secretResolutionHeaderName} header value "${raw}". Use "off" to send secret placeholders literally without resolution, or omit the header for normal resolution.`,
	)
}

function collectReferencedSecrets(values: Array<string | null | undefined>) {
	return dedupeReferencedSecrets(
		values.flatMap((value) => (value ? parseSecretPlaceholders(value) : [])),
	)
}

function collectReferencedBasicAuthSecretPlaceholders(
	values: Array<string | null | undefined>,
) {
	return dedupeBasicAuthSecretPlaceholders(
		values.flatMap((value) =>
			value ? parseBasicAuthSecretPlaceholders(value) : [],
		),
	)
}

function collectReferencedBasicAuthSecretPlaceholdersFromRequestBody(
	headers: Headers,
	requestBody: GatewayRequestBody | null,
) {
	if (requestBody?.kind !== 'text' || !requestBody.text) return []
	return isFormUrlEncodedRequest(headers)
		? dedupeBasicAuthSecretPlaceholders(
				parseBasicAuthSecretPlaceholdersFromFormUrlEncoded(requestBody.text),
			)
		: collectReferencedBasicAuthSecretPlaceholders([requestBody.text])
}

function collectReferencedSecretsFromRequestBody(
	headers: Headers,
	requestBody: GatewayRequestBody | null,
) {
	if (requestBody?.kind !== 'text' || !requestBody.text) return []
	return isFormUrlEncodedRequest(headers)
		? dedupeReferencedSecrets(
				parseSecretPlaceholdersFromFormUrlEncoded(requestBody.text),
			)
		: collectReferencedSecrets([requestBody.text])
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

function replaceSecretPlaceholdersInRequestBody(
	headers: Headers,
	requestBody: string,
	replacements: ReadonlyMap<string, string>,
) {
	return isFormUrlEncodedRequest(headers)
		? replaceSecretPlaceholdersInFormUrlEncoded(requestBody, replacements)
		: replaceSecretPlaceholders(requestBody, replacements)
}

function isFormUrlEncodedRequest(headers: Headers) {
	const contentType = headers.get('Content-Type')?.toLowerCase() ?? ''
	return contentType.startsWith('application/x-www-form-urlencoded')
}

type GatewayRequestBody =
	| { kind: 'text'; text: string }
	| { kind: 'binary'; bytes: Uint8Array<ArrayBuffer> }

/**
 * Read the outbound request body without corrupting binary payloads. Bodies
 * that decode as valid UTF-8 keep the text pipeline (secret placeholder
 * scanning and replacement). Anything else — for example multipart uploads
 * carrying raw file bytes — passes through byte-for-byte, and secret
 * placeholders inside such a body are intentionally not resolved (URL and
 * header placeholders still are).
 */
async function readRequestBody(
	request: Request,
): Promise<GatewayRequestBody | null> {
	if (!shouldSendBody(request.method)) return null
	const bytes = new Uint8Array(await request.arrayBuffer())
	try {
		// ignoreBOM keeps a leading UTF-8 BOM in the decoded text so text
		// bodies round-trip byte-for-byte after placeholder expansion.
		const text = new TextDecoder('utf-8', {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes)
		return { kind: 'text', text }
	} catch {
		return { kind: 'binary', bytes }
	}
}

function requestBodyInit(requestBody: GatewayRequestBody | null) {
	if (requestBody == null) return undefined
	return requestBody.kind === 'binary' ? requestBody.bytes : requestBody.text
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
