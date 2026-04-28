import { WorkerEntrypoint } from 'cloudflare:workers'
import { buildSecretHostApprovalUrl } from '#mcp/secrets/host-approval.ts'
import {
	buildSecretPlaceholder,
	parseSecretPlaceholders,
	parseSecretPlaceholdersFromFormUrlEncoded,
	replaceSecretPlaceholders,
	replaceSecretPlaceholdersInFormUrlEncoded,
	type ReferencedSecret,
} from '#mcp/secrets/placeholders.ts'
import {
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	fetchSecretAuthRequiredMessage,
} from '#mcp/secrets/errors.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import { resolveSecret, type ResolvedSecret } from '#mcp/secrets/service.ts'
import { type StorageContext } from '#mcp/storage.ts'

type FetchGatewayProps = {
	baseUrl: string
	userId: string | null
	storageContext: StorageContext | null
}
export type { FetchGatewayProps }

export class CodemodeFetchGateway extends WorkerEntrypoint<
	Env,
	FetchGatewayProps
> {
	async fetch(request: Request) {
		const transformed = await expandSecretPlaceholders({
			request,
			props: this.ctx.props,
			env: this.env,
		})
		return fetch(transformed)
	}
}

export async function expandSecretPlaceholders(input: {
	request: Request
	props: FetchGatewayProps
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
}) {
	const headers = new Headers(input.request.headers)
	const requestBody = await readRequestBody(input.request)
	const resolvedSecrets: Array<{
		referenced: ReferencedSecret
		resolved: ResolvedSecret
	}> = []
	const replacements = new Map<string, string>()
	const baseUrl = input.props.baseUrl.trim()
	if (!baseUrl) {
		throw new Error('Fetch gateway requires a non-empty baseUrl in props.')
	}
	const referencedSecrets = dedupeReferencedSecrets([
		...collectReferencedSecrets([
			input.request.url,
			...Array.from(headers.values()),
		]),
		...collectReferencedSecretsFromRequestBody(headers, requestBody),
	])
	const hasReferencedSecrets = referencedSecrets.length > 0
	if (hasReferencedSecrets) {
		ensureFetchAllowed(input.props)
	}
	for (const referenced of referencedSecrets) {
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
		const placeholder = buildSecretPlaceholder(referenced)
		if (!replacements.has(placeholder)) {
			replacements.set(placeholder, resolved.value)
		}
		resolvedSecrets.push({ referenced, resolved })
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
			: replaceSecretPlaceholdersInRequestBody(
					headers,
					requestBody,
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
 * Codemode / sandboxed fetch may emit path-only URLs (e.g. `/`, `/core/log`).
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
	try {
		return new URL(url).hostname
	} catch {
		return ''
	}
}

function ensureFetchAllowed(props: FetchGatewayProps) {
	if (!props.userId) {
		throw new Error(fetchSecretAuthRequiredMessage)
	}
}

function collectReferencedSecrets(values: Array<string | null | undefined>) {
	return dedupeReferencedSecrets(
		values.flatMap((value) => (value ? parseSecretPlaceholders(value) : [])),
	)
}

function collectReferencedSecretsFromRequestBody(
	headers: Headers,
	requestBody: string | null,
) {
	if (!requestBody) return []
	return isFormUrlEncodedRequest(headers)
		? dedupeReferencedSecrets(
				parseSecretPlaceholdersFromFormUrlEncoded(requestBody),
			)
		: collectReferencedSecrets([requestBody])
}

function dedupeReferencedSecrets(referencedSecrets: Array<ReferencedSecret>) {
	const deduped = new Map<string, ReferencedSecret>()
	for (const referenced of referencedSecrets) {
		deduped.set(buildSecretPlaceholder(referenced), referenced)
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

async function readRequestBody(request: Request) {
	if (!shouldSendBody(request.method)) return null
	return request.text()
}

function shouldSendBody(method: string) {
	return method !== 'GET' && method !== 'HEAD'
}
