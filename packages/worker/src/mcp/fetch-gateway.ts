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
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
}) {
	const headers = new Headers(input.request.headers)
	const requestBody = await readRequestBody(input.request)
	const resolvedSecrets: Array<{
		referenced: ReferencedSecret
		resolved: ResolvedSecret
	}> = []
	const replacements = new Map<string, string>()
	const resolvedValues = new Map<string, string>()
	const baseUrl = input.props.baseUrl.trim()
	if (!baseUrl) {
		throw new Error('Fetch gateway requires a non-empty baseUrl in props.')
	}
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
		if (!resolvedValues.has(placeholder)) {
			resolvedValues.set(placeholder, resolved.value)
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
	return new URL(url).hostname
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
	requestBody: string | null,
) {
	if (!requestBody) return []
	return isFormUrlEncodedRequest(headers)
		? dedupeBasicAuthSecretPlaceholders(
				parseBasicAuthSecretPlaceholdersFromFormUrlEncoded(requestBody),
			)
		: collectReferencedBasicAuthSecretPlaceholders([requestBody])
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

async function readRequestBody(request: Request) {
	if (!shouldSendBody(request.method)) return null
	return request.text()
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
	return `Basic ${encodeBase64(`${input.username}:${input.password}`)}`
}

function encodeBase64(value: string) {
	const bytes = new TextEncoder().encode(value)
	let binary = ''
	const chunkSize = 0x8000
	for (let index = 0; index < bytes.length; index += chunkSize) {
		const chunk = bytes.slice(index, index + chunkSize)
		binary += String.fromCharCode(...chunk)
	}
	return btoa(binary)
}
