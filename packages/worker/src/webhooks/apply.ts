import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import { buildSecretHostApprovalUrl } from '#mcp/secrets/host-approval.ts'
import { resolveSecretForHost } from '#mcp/secrets/service.ts'
import { assertCanUseIntegration } from '#worker/integrations/package-access.ts'
import { resolveIntegrationAccessToken } from '#worker/integrations/credentials.ts'
import { getJoinedIntegration } from '#worker/integrations/service.ts'
import { refreshIntegrationTokens } from '#worker/integrations/token-refresh.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import {
	collectWebhookCredentialSecrets,
	redactWebhookCredentials,
} from './redact.ts'

export const webhookUrlApplyHttpMethods = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
] as const

/** Server-side substitution token for the minted credential URL. */
export const webhookUrlApplyPlaceholder = '{{webhookUrl}}'

export type WebhookUrlApplyHttpDestination = {
	type: 'http'
	/** HTTPS registration endpoint. May include {{webhookUrl}}. */
	url: string
	method?: (typeof webhookUrlApplyHttpMethods)[number]
	/** Header values may include {{webhookUrl}}. */
	headers?: Record<string, string>
	/** Request body template; may include {{webhookUrl}}. */
	body?: string
	integration?: string
	secretName?: string
}

export type WebhookUrlApplyDestination = WebhookUrlApplyHttpDestination

export type WebhookUrlApplyResult = {
	ok: boolean
	urlHost: string
	httpStatus: number
	remoteId: string | null
	error: string | null
}

const applyResponseBodyMaxBytes = 16_384
const applyRequestBodyMaxBytes = 64_384
const applyErrorSnippetMaxChars = 300
const applyRequestTimeoutMs = 15_000
const applyHttpMaxHeaderCount = 32

function integrationAllowedHosts(joined: JoinedIntegration) {
	const hosts = new Set<string>()
	for (const host of joined.connection.requiredHosts) {
		const normalized = normalizeHost(host)
		if (normalized) hosts.add(normalized)
	}
	if (joined.lane === 'platform') {
		for (const host of joined.app.requiredHosts) {
			const normalized = normalizeHost(host)
			if (normalized) hosts.add(normalized)
		}
	}
	if (joined.app.apiBaseUrl) {
		try {
			const apiHost = normalizeHost(new URL(joined.app.apiBaseUrl).hostname)
			if (apiHost) hosts.add(apiHost)
		} catch {
			// Invalid apiBaseUrl is ignored; host checks still use requiredHosts.
		}
	}
	return hosts
}

function assertDestinationHostAllowed(input: {
	joined: JoinedIntegration
	integrationName: string
	url: string
}) {
	const host = normalizeHost(new URL(input.url).hostname)
	if (integrationAllowedHosts(input.joined).has(host)) return
	throw new McpCallerError(
		`Integration "${input.integrationName}" does not allow requests to host "${host}".`,
	)
}

async function authorizeApplyRequest(input: {
	env: Env
	userId: string
	userEmail?: string | null
	baseUrl: string
	packageId: string
	packageKodyId: string
	url: string
	integration?: string
	secretName?: string
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	authorization: string | null
	retryAuthorization: (() => Promise<string>) | null
}> {
	const secretName = input.secretName?.trim() ?? ''
	const integrationName = input.integration?.trim() ?? ''
	if (secretName && integrationName) {
		throw new McpCallerError(
			'Provide either integration or secretName, not both.',
		)
	}
	if (secretName) {
		const host = normalizeHost(new URL(input.url).hostname)
		const resolved = await resolveSecretForHost({
			env: input.env,
			userId: input.userId,
			name: secretName,
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: input.packageId,
			},
			host,
		})
		if (!resolved.found || !resolved.value) {
			throw new McpCallerError(
				`Secret "${secretName}" was not found for this user.`,
			)
		}
		if (!resolved.allowedHosts.includes(host)) {
			const approvalUrl = buildSecretHostApprovalUrl({
				baseUrl: input.baseUrl,
				name: secretName,
				scope: resolved.scope ?? 'user',
				requestedHost: host,
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: input.packageId,
				},
			})
			throw new McpCallerError(
				`Secret "${secretName}" is not approved for host "${host}". Approve it at ${approvalUrl}.`,
			)
		}
		const authorization = `Bearer ${resolved.value}`
		return {
			authorization,
			retryAuthorization: async () => authorization,
		}
	}

	if (!integrationName) {
		return { authorization: null, retryAuthorization: null }
	}
	const joined = await getJoinedIntegration({
		env: input.env,
		userId: input.userId,
		name: integrationName,
	})
	if (!joined) {
		throw new McpCallerError(
			`Integration "${integrationName}" was not found. Connect it at /connect/oauth?provider=${encodeURIComponent(integrationName)} or pass secretName for a host-approved token.`,
		)
	}
	await assertCanUseIntegration({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		name: integrationName,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
	})
	assertDestinationHostAllowed({
		joined,
		integrationName,
		url: input.url,
	})
	const readToken = async () => {
		const token = await resolveIntegrationAccessToken({
			env: input.env,
			userId: input.userId,
			name: integrationName,
		})
		if (!token) {
			throw new McpCallerError(
				`Integration "${integrationName}" does not have a stored access token. Reconnect at /connect/oauth?provider=${encodeURIComponent(integrationName)}.`,
			)
		}
		return `Bearer ${token}`
	}
	return {
		authorization: await readToken(),
		retryAuthorization: async () => {
			await refreshIntegrationTokens({
				env: input.env,
				userId: input.userId,
				userEmail: input.userEmail ?? undefined,
				name: integrationName,
				baseUrl: input.baseUrl,
				packageId: input.packageId,
				packageKodyId: input.packageKodyId,
				waitUntil: input.waitUntil,
			})
			return readToken()
		},
	}
}

function extractRemoteId(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		return null
	}
	const id = (payload as { id?: unknown }).id
	if (typeof id === 'number' && Number.isFinite(id)) return String(id)
	if (typeof id === 'string' && id.trim()) return id.trim()
	return null
}

function parseJsonPayload(text: string): unknown {
	if (!text.trim()) return null
	try {
		return JSON.parse(text) as unknown
	} catch {
		return null
	}
}

function isRedirectStatus(status: number) {
	return status >= 300 && status < 400
}

function applyFetchInit(input: {
	method: string
	headers: Headers
	body?: string
}): RequestInit {
	return {
		method: input.method,
		headers: input.headers,
		body: input.body,
		redirect: 'manual',
		signal: AbortSignal.timeout(applyRequestTimeoutMs),
	}
}

async function fetchApplyDestination(input: {
	url: string
	method: string
	headers: Headers
	body?: string
}): Promise<Response> {
	try {
		return await fetch(input.url, applyFetchInit(input))
	} catch (error) {
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			throw new McpCallerError('Destination request timed out.')
		}
		throw error
	}
}

async function readApplyResponseBody(response: Response): Promise<string> {
	if (response.body == null) {
		const text = await response.text()
		return text.length > applyResponseBodyMaxBytes
			? text.slice(0, applyResponseBodyMaxBytes)
			: text
	}
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let body = ''
	let totalBytes = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			if (!value || value.byteLength === 0) continue
			if (totalBytes + value.byteLength > applyResponseBodyMaxBytes) {
				const remaining = applyResponseBodyMaxBytes - totalBytes
				if (remaining > 0) {
					body += decoder.decode(value.slice(0, remaining), { stream: true })
				}
				void reader.cancel().catch(() => {})
				break
			}
			totalBytes += value.byteLength
			body += decoder.decode(value, { stream: true })
		}
		body += decoder.decode()
		return body
	} catch (error) {
		void reader.cancel().catch(() => {})
		throw error
	}
}

async function sendAuthorizedApplyRequest(input: {
	url: string
	method: string
	headers: Record<string, string>
	body?: string
	authorization: string | null
	retryAuthorization: (() => Promise<string>) | null
	secrets: ReadonlyArray<string>
}): Promise<WebhookUrlApplyResult> {
	const headers = new Headers(input.headers)
	if (input.authorization) {
		headers.set('Authorization', input.authorization)
	}
	let response = await fetchApplyDestination({
		url: input.url,
		method: input.method,
		headers,
		body: input.body,
	})
	if (isRedirectStatus(response.status)) {
		await response.body?.cancel()
		return {
			ok: false,
			urlHost: '',
			httpStatus: response.status,
			remoteId: null,
			error: 'Destination redirected. Apply does not follow redirects.',
		}
	}
	let secrets = [...input.secrets]
	if (response.status === 401 && input.retryAuthorization) {
		await response.body?.cancel()
		const retryAuthorization = await input.retryAuthorization()
		secrets = [
			...secrets,
			...collectAuthorizationSecretsForRedaction({
				authorization: retryAuthorization,
			}),
		]
		const retryHeaders = new Headers(input.headers)
		retryHeaders.set('Authorization', retryAuthorization)
		response = await fetchApplyDestination({
			url: input.url,
			method: input.method,
			headers: retryHeaders,
			body: input.body,
		})
		if (isRedirectStatus(response.status)) {
			await response.body?.cancel()
			return {
				ok: false,
				urlHost: '',
				httpStatus: response.status,
				remoteId: null,
				error: 'Destination redirected. Apply does not follow redirects.',
			}
		}
	}
	const rawBody = await readApplyResponseBody(response)
	const redactedBody = String(redactWebhookCredentials(rawBody, secrets) ?? '')
	const payload = parseJsonPayload(redactedBody)
	const remoteId = extractRemoteId(payload)
	if (response.ok) {
		return {
			ok: true,
			urlHost: '',
			httpStatus: response.status,
			remoteId,
			error: null,
		}
	}
	const snippet =
		redactedBody.trim().length > 0
			? redactedBody.trim().slice(0, applyErrorSnippetMaxChars)
			: response.statusText
	return {
		ok: false,
		urlHost: '',
		httpStatus: response.status,
		remoteId,
		error: String(redactWebhookCredentials(snippet, secrets) ?? snippet),
	}
}

function countWebhookUrlPlaceholders(value: string) {
	let count = 0
	let index = 0
	while (true) {
		const next = value.indexOf(webhookUrlApplyPlaceholder, index)
		if (next === -1) break
		count += 1
		index = next + webhookUrlApplyPlaceholder.length
	}
	return count
}

function countWebhookUrlPlaceholdersInUrl(value: string) {
	const fragmentIndex = value.indexOf('#')
	return countWebhookUrlPlaceholders(
		fragmentIndex === -1 ? value : value.slice(0, fragmentIndex),
	)
}

function substituteWebhookUrlPlaceholder(
	value: string,
	webhookUrl: string,
	encode: boolean,
) {
	const replacement = encode ? encodeURIComponent(webhookUrl) : webhookUrl
	return value.split(webhookUrlApplyPlaceholder).join(replacement)
}

export function isFormUrlEncodedContentType(contentType: string | null) {
	if (!contentType) return false
	return (
		contentType.split(';', 1)[0]!.trim().toLowerCase() ===
		'application/x-www-form-urlencoded'
	)
}

export function countWebhookUrlPlaceholdersInFormBody(body: string) {
	let count = 0
	const params = new URLSearchParams(body)
	for (const [key, value] of params) {
		count += countWebhookUrlPlaceholders(key)
		count += countWebhookUrlPlaceholders(value)
	}
	return count
}

export function httpDestinationIncludesWebhookUrlPlaceholder(destination: {
	url: string
	headers?: Record<string, string>
	body?: string
}) {
	const urlTemplate = destination.url.trim()
	const headers = destination.headers ?? {}
	const headerEntries = Object.entries(headers)
	const body = destination.body ?? ''
	let placeholderCount =
		countWebhookUrlPlaceholdersInUrl(urlTemplate) +
		headerEntries.reduce(
			(sum, [, value]) => sum + countWebhookUrlPlaceholders(value),
			0,
		) +
		countWebhookUrlPlaceholders(body)
	if (placeholderCount >= 1) return true
	const contentType =
		headerEntries.find(
			([name]) => name.toLowerCase() === 'content-type',
		)?.[1] ?? null
	if (!isFormUrlEncodedContentType(contentType)) return false
	return countWebhookUrlPlaceholdersInFormBody(body) >= 1
}

function collectAuthorizationSecretsForRedaction(input: {
	authorization: string | null
	headers?: Record<string, string>
}) {
	const secrets: Array<string> = []
	const candidates = [
		input.authorization,
		...Object.entries(input.headers ?? {})
			.filter(([name]) => name.toLowerCase() === 'authorization')
			.map(([, value]) => value),
	]
	for (const value of candidates) {
		if (!value) continue
		const variants = [value]
		const bearerMatch = /^Bearer\s+(.+)$/i.exec(value.trim())
		if (bearerMatch?.[1]) variants.push(bearerMatch[1])
		for (const variant of variants) {
			secrets.push(variant)
			const encoded = encodeURIComponent(variant)
			if (encoded !== variant) secrets.push(encoded)
		}
	}
	return secrets
}

function substituteWebhookUrlInFormBody(body: string, webhookUrl: string) {
	const params = new URLSearchParams(body)
	const next = new URLSearchParams()
	for (const [key, value] of params) {
		next.append(
			substituteWebhookUrlPlaceholder(key, webhookUrl, false),
			substituteWebhookUrlPlaceholder(value, webhookUrl, false),
		)
	}
	return next.toString()
}

function assertHttpsDestinationUrl(url: string) {
	let parsed: URL
	try {
		parsed = new URL(url)
	} catch {
		throw new McpCallerError('Destination url must be a valid https URL.')
	}
	if (parsed.protocol !== 'https:') {
		throw new McpCallerError('Destination url must use https.')
	}
	if (parsed.username || parsed.password) {
		throw new McpCallerError(
			'Destination url must not include username or password.',
		)
	}
	return parsed
}

function validateHttpDestinationTemplate(
	destination: WebhookUrlApplyHttpDestination,
) {
	const urlTemplate = destination.url.trim()
	if (!urlTemplate) {
		throw new McpCallerError('Destination url is required.')
	}
	const headers = destination.headers ?? {}
	const headerEntries = Object.entries(headers)
	if (headerEntries.length > applyHttpMaxHeaderCount) {
		throw new McpCallerError(
			`Destination headers are limited to ${applyHttpMaxHeaderCount} entries.`,
		)
	}
	for (const [name, value] of headerEntries) {
		if (!name.trim()) {
			throw new McpCallerError('Destination header names must be non-empty.')
		}
		if (typeof value !== 'string') {
			throw new McpCallerError('Destination header values must be strings.')
		}
	}
	const body = destination.body ?? ''
	if (body.length > applyRequestBodyMaxBytes) {
		throw new McpCallerError(
			`Destination body must be at most ${applyRequestBodyMaxBytes} bytes.`,
		)
	}
	const method = (destination.method ?? 'POST').toUpperCase()
	if (method === 'GET' && body.length > 0) {
		throw new McpCallerError('Destination body is not allowed with GET.')
	}
	if (
		!httpDestinationIncludesWebhookUrlPlaceholder({
			url: urlTemplate,
			headers,
			body,
		})
	) {
		throw new McpCallerError(
			`Destination must include ${webhookUrlApplyPlaceholder} in url, headers, or body so the minted URL is injected server-side.`,
		)
	}
	const urlForValidation = substituteWebhookUrlPlaceholder(
		urlTemplate,
		'https://webhook.invalid/apply',
		true,
	)
	assertHttpsDestinationUrl(urlForValidation)
	const hasAuthorizationHeader = headerEntries.some(
		([name]) => name.toLowerCase() === 'authorization',
	)
	const hasAuthSource = Boolean(
		destination.secretName?.trim() || destination.integration?.trim(),
	)
	if (hasAuthorizationHeader && hasAuthSource) {
		throw new McpCallerError(
			'Provide Authorization in headers, or secretName/integration, not both.',
		)
	}
	return { urlTemplate, headers, body, method }
}

async function dispatchHttpApply(input: {
	env: Env
	userId: string
	userEmail?: string | null
	baseUrl: string
	packageId: string
	packageKodyId: string
	webhookUrl: string
	urlSecret: string
	destination: WebhookUrlApplyHttpDestination
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<WebhookUrlApplyResult> {
	const { urlTemplate, headers, body, method } =
		validateHttpDestinationTemplate(input.destination)
	const contentType =
		Object.entries(headers).find(
			([name]) => name.toLowerCase() === 'content-type',
		)?.[1] ?? null
	const resolvedUrl = assertHttpsDestinationUrl(
		substituteWebhookUrlPlaceholder(urlTemplate, input.webhookUrl, true),
	).toString()
	const resolvedHeaders: Record<string, string> = {}
	for (const [name, value] of Object.entries(headers)) {
		resolvedHeaders[name] = substituteWebhookUrlPlaceholder(
			value,
			input.webhookUrl,
			false,
		)
	}
	let resolvedBody: string | undefined
	if (body.length > 0) {
		resolvedBody = isFormUrlEncodedContentType(contentType)
			? substituteWebhookUrlInFormBody(body, input.webhookUrl)
			: substituteWebhookUrlPlaceholder(body, input.webhookUrl, false)
	}
	const auth = await authorizeApplyRequest({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		baseUrl: input.baseUrl,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
		url: resolvedUrl,
		integration: input.destination.integration,
		secretName: input.destination.secretName,
		waitUntil: input.waitUntil,
	})
	const secrets = [
		...collectWebhookCredentialSecrets({
			url: input.webhookUrl,
			urlSecret: input.urlSecret,
		}),
		...collectAuthorizationSecretsForRedaction({
			authorization: auth.authorization,
			headers: resolvedHeaders,
		}),
	]
	return sendAuthorizedApplyRequest({
		url: resolvedUrl,
		method,
		headers: resolvedHeaders,
		body: resolvedBody,
		authorization: auth.authorization,
		retryAuthorization: auth.retryAuthorization,
		secrets,
	})
}

export async function dispatchWebhookUrlApply(input: {
	env: Env
	userId: string
	userEmail?: string | null
	baseUrl: string
	packageId: string
	packageKodyId: string
	webhookUrl: string
	urlSecret: string
	urlHost: string
	destination: WebhookUrlApplyDestination
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<WebhookUrlApplyResult> {
	const result = await dispatchHttpApply({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		baseUrl: input.baseUrl,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
		webhookUrl: input.webhookUrl,
		urlSecret: input.urlSecret,
		destination: input.destination,
		waitUntil: input.waitUntil,
	})
	const secrets = collectWebhookCredentialSecrets({
		url: input.webhookUrl,
		urlSecret: input.urlSecret,
	})
	return {
		ok: result.ok,
		urlHost: input.urlHost,
		httpStatus: result.httpStatus,
		remoteId: result.remoteId,
		error:
			typeof result.error === 'string'
				? String(
						redactWebhookCredentials(result.error, secrets) ?? result.error,
					)
				: null,
	}
}
