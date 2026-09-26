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
	listPackageWebhooks,
	type PackageWebhookManifestEntry,
} from '#worker/package-registry/manifest.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	collectWebhookCredentialSecrets,
	redactWebhookCredentials,
} from './redact.ts'

export const webhookUrlApplyGithubContentTypes = ['json', 'form'] as const

export const webhookUrlApplyHttpMethods = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
] as const

/** Server-side substitution token for the minted credential URL. */
export const webhookUrlApplyPlaceholder = '{{webhookUrl}}'

export type WebhookUrlApplyGithubDestination = {
	type: 'github'
	owner: string
	repo: string
	events?: Array<string>
	contentType?: (typeof webhookUrlApplyGithubContentTypes)[number]
	active?: boolean
	integration?: string
	secretName?: string
	hookSecretName?: string
}

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

export type WebhookUrlApplyDestination =
	| WebhookUrlApplyGithubDestination
	| WebhookUrlApplyHttpDestination

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
const defaultGithubEvents = ['push'] as const
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

async function loadDeclaredWebhookIfPresent(input: {
	env: Env
	baseUrl: string
	userId: string
	savedPackage: SavedPackageRecord
	webhookName: string
}): Promise<PackageWebhookManifestEntry | null> {
	let loaded
	try {
		loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: input.savedPackage.sourceId,
		})
	} catch {
		throw new McpCallerError(
			'Could not load the package manifest to read webhook verification. Retry after the package source is available.',
		)
	}
	return (
		listPackageWebhooks(loaded.manifest).find(
			(webhook) => webhook.name === input.webhookName,
		) ?? null
	)
}

function assertGithubRepoSlug(value: string, label: 'owner' | 'repository') {
	if (value === '.' || value === '..' || !/^[A-Za-z0-9_.-]+$/.test(value)) {
		throw new McpCallerError(`Must be a GitHub ${label} slug.`)
	}
}

async function resolveHookSigningSecret(input: {
	env: Env
	userId: string
	packageId: string
	baseUrl: string
	secretName: string
}) {
	const resolved = await resolveSecretForHost({
		env: input.env,
		userId: input.userId,
		name: input.secretName,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: input.packageId,
		},
		host: 'api.github.com',
	})
	if (!resolved.found || !resolved.value) {
		throw new McpCallerError(
			`Secret "${input.secretName}" was not found for this user.`,
		)
	}
	if (!resolved.allowedHosts.includes('api.github.com')) {
		const approvalUrl = buildSecretHostApprovalUrl({
			baseUrl: input.baseUrl,
			name: input.secretName,
			scope: resolved.scope ?? 'user',
			requestedHost: 'api.github.com',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: input.packageId,
			},
		})
		throw new McpCallerError(
			`Secret "${input.secretName}" is not approved for host "api.github.com". Approve it at ${approvalUrl}.`,
		)
	}
	return resolved.value
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
	/** When set, used if neither secretName nor integration is provided. */
	defaultIntegration?: string | null
	/** When false, missing auth is allowed (http destinations). Default true. */
	requireAuthorization?: boolean
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

	const fallback = input.defaultIntegration?.trim() || ''
	const name = integrationName || fallback
	if (!name) {
		if (input.requireAuthorization === false) {
			return { authorization: null, retryAuthorization: null }
		}
		throw new McpCallerError(
			'Provide integration or secretName to authorize the apply request.',
		)
	}
	const joined = await getJoinedIntegration({
		env: input.env,
		userId: input.userId,
		name,
	})
	if (!joined) {
		throw new McpCallerError(
			`Integration "${name}" was not found. Connect it at /connect/oauth?provider=${encodeURIComponent(name)} or pass secretName for a host-approved token.`,
		)
	}
	await assertCanUseIntegration({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		name,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
	})
	assertDestinationHostAllowed({
		joined,
		integrationName: name,
		url: input.url,
	})
	const readToken = async () => {
		const token = await resolveIntegrationAccessToken({
			env: input.env,
			userId: input.userId,
			name,
		})
		if (!token) {
			throw new McpCallerError(
				`Integration "${name}" does not have a stored access token. Reconnect at /connect/oauth?provider=${encodeURIComponent(name)}.`,
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
				name,
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
	if (response.status === 401 && input.retryAuthorization) {
		await response.body?.cancel()
		const retryHeaders = new Headers(input.headers)
		retryHeaders.set('Authorization', await input.retryAuthorization())
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
	const redactedBody = String(
		redactWebhookCredentials(rawBody, input.secrets) ?? '',
	)
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
		error: String(redactWebhookCredentials(snippet, input.secrets) ?? snippet),
	}
}

async function dispatchGithubApply(input: {
	env: Env
	userId: string
	userEmail?: string | null
	baseUrl: string
	packageId: string
	packageKodyId: string
	webhookName: string
	savedPackage: SavedPackageRecord
	webhookUrl: string
	urlSecret: string
	destination: WebhookUrlApplyGithubDestination
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<WebhookUrlApplyResult> {
	const owner = input.destination.owner.trim()
	const repo = input.destination.repo.trim()
	assertGithubRepoSlug(owner, 'owner')
	assertGithubRepoSlug(repo, 'repository')
	const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`
	const declared = await loadDeclaredWebhookIfPresent({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		savedPackage: input.savedPackage,
		webhookName: input.webhookName,
	})
	const hookSecretName =
		input.destination.hookSecretName?.trim() ||
		declared?.verification?.secretName ||
		''
	const hookSecret = hookSecretName
		? await resolveHookSigningSecret({
				env: input.env,
				userId: input.userId,
				packageId: input.packageId,
				baseUrl: input.baseUrl,
				secretName: hookSecretName,
			})
		: null
	const config: Record<string, string> = {
		url: input.webhookUrl,
		content_type: input.destination.contentType ?? 'json',
		insecure_ssl: '0',
	}
	if (hookSecret) config.secret = hookSecret
	const body = JSON.stringify({
		name: 'web',
		active: input.destination.active !== false,
		events: input.destination.events?.length
			? input.destination.events
			: [...defaultGithubEvents],
		config,
	})
	const auth = await authorizeApplyRequest({
		env: input.env,
		userId: input.userId,
		userEmail: input.userEmail,
		baseUrl: input.baseUrl,
		packageId: input.packageId,
		packageKodyId: input.packageKodyId,
		url,
		integration: input.destination.integration,
		secretName: input.destination.secretName,
		defaultIntegration: 'github',
		requireAuthorization: true,
		waitUntil: input.waitUntil,
	})
	const secrets = [
		...collectWebhookCredentialSecrets({
			url: input.webhookUrl,
			urlSecret: input.urlSecret,
		}),
		...collectAuthorizationSecretsForRedaction({
			authorization: auth.authorization,
		}),
	]
	if (hookSecret) secrets.push(hookSecret)
	if (!auth.authorization || !auth.retryAuthorization) {
		throw new McpCallerError(
			'GitHub apply requires authorization via integration or secretName.',
		)
	}
	return sendAuthorizedApplyRequest({
		url,
		method: 'POST',
		headers: {
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'User-Agent': 'kody',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		body,
		authorization: auth.authorization,
		retryAuthorization: auth.retryAuthorization,
		secrets,
	})
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

function substituteWebhookUrlPlaceholder(
	value: string,
	webhookUrl: string,
	encode: boolean,
) {
	const replacement = encode ? encodeURIComponent(webhookUrl) : webhookUrl
	return value.split(webhookUrlApplyPlaceholder).join(replacement)
}

function isFormUrlEncodedContentType(contentType: string | null) {
	if (!contentType) return false
	return (
		contentType.split(';', 1)[0]!.trim().toLowerCase() ===
		'application/x-www-form-urlencoded'
	)
}

function countWebhookUrlPlaceholdersInFormBody(body: string) {
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
		countWebhookUrlPlaceholders(urlTemplate) +
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
		secrets.push(value)
		const bearerMatch = /^Bearer\s+(.+)$/i.exec(value.trim())
		if (bearerMatch?.[1]) secrets.push(bearerMatch[1])
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
		defaultIntegration: null,
		requireAuthorization: false,
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
	webhookName: string
	savedPackage: SavedPackageRecord
	webhookUrl: string
	urlSecret: string
	urlHost: string
	destination: WebhookUrlApplyDestination
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<WebhookUrlApplyResult> {
	let result: WebhookUrlApplyResult
	switch (input.destination.type) {
		case 'github':
			result = await dispatchGithubApply({
				env: input.env,
				userId: input.userId,
				userEmail: input.userEmail,
				baseUrl: input.baseUrl,
				packageId: input.packageId,
				packageKodyId: input.packageKodyId,
				webhookName: input.webhookName,
				savedPackage: input.savedPackage,
				webhookUrl: input.webhookUrl,
				urlSecret: input.urlSecret,
				destination: input.destination,
				waitUntil: input.waitUntil,
			})
			break
		case 'http':
			result = await dispatchHttpApply({
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
			break
		default: {
			const exhaustive: never = input.destination
			throw new McpCallerError(
				`Unsupported webhook apply destination type: ${String(
					(exhaustive as { type?: unknown }).type,
				)}.`,
			)
		}
	}
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
