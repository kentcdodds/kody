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
	substituteWebhookUrlPlaceholder,
	templateIncludesWebhookUrlPlaceholder,
	webhookUrlPlaceholder,
} from './redact.ts'

export const webhookUrlApplyHttpsMethods = ['POST', 'PUT', 'PATCH'] as const
export const webhookUrlApplyGithubContentTypes = ['json', 'form'] as const

export type WebhookUrlApplyHttpsDestination = {
	type: 'https'
	url: string
	method?: (typeof webhookUrlApplyHttpsMethods)[number]
	headers?: Record<string, string>
	body?: string
	integration?: string
	secretName?: string
}

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

export type WebhookUrlApplyDestination =
	| WebhookUrlApplyHttpsDestination
	| WebhookUrlApplyGithubDestination

export type WebhookUrlApplyResult = {
	ok: boolean
	urlHost: string
	httpStatus: number
	remoteId: string | null
	error: string | null
}

const applyResponseBodyMaxChars = 16_384
const applyErrorSnippetMaxChars = 300
const defaultGithubEvents = ['push'] as const

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
	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	}).catch(() => null)
	if (!loaded) return null
	return (
		listPackageWebhooks(loaded.manifest).find(
			(webhook) => webhook.name === input.webhookName,
		) ?? null
	)
}

async function resolveHookSigningSecret(input: {
	env: Env
	userId: string
	packageId: string
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
	if (!resolved.found || !resolved.value) return null
	if (!resolved.allowedHosts.includes('api.github.com')) return null
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
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	authorization: string
	retryAuthorization: () => Promise<string>
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

	const name = integrationName || 'github'
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

async function sendAuthorizedApplyRequest(input: {
	url: string
	method: string
	headers: Record<string, string>
	body?: string
	authorization: string
	retryAuthorization: () => Promise<string>
	secrets: ReadonlyArray<string>
}): Promise<WebhookUrlApplyResult> {
	const headers = new Headers(input.headers)
	headers.set('Authorization', input.authorization)
	let response = await fetch(input.url, {
		method: input.method,
		headers,
		body: input.body,
	})
	if (response.status === 401) {
		await response.body?.cancel()
		const retryHeaders = new Headers(input.headers)
		retryHeaders.set('Authorization', await input.retryAuthorization())
		response = await fetch(input.url, {
			method: input.method,
			headers: retryHeaders,
			body: input.body,
		})
	}
	const rawBody = await response.text()
	const bounded =
		rawBody.length > applyResponseBodyMaxChars
			? rawBody.slice(0, applyResponseBodyMaxChars)
			: rawBody
	const redactedBody = String(
		redactWebhookCredentials(bounded, input.secrets) ?? '',
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

function requireHttpsPlaceholder(input: {
	url: string
	headers?: Record<string, string>
	body?: string
}) {
	const headerValues = Object.values(input.headers ?? {}).join('\n')
	const haystack = `${input.url}\n${headerValues}\n${input.body ?? ''}`
	if (templateIncludesWebhookUrlPlaceholder(haystack)) return
	throw new McpCallerError(
		`HTTPS apply must include ${webhookUrlPlaceholder} in url, headers, or body so Kody can substitute the credential server-side.`,
	)
}

async function dispatchHttpsApply(input: {
	env: Env
	userId: string
	userEmail?: string | null
	baseUrl: string
	packageId: string
	packageKodyId: string
	webhookUrl: string
	urlSecret: string
	destination: WebhookUrlApplyHttpsDestination
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<WebhookUrlApplyResult> {
	requireHttpsPlaceholder(input.destination)
	const url = substituteWebhookUrlPlaceholder(
		input.destination.url,
		input.webhookUrl,
	)
	const headers: Record<string, string> = {}
	for (const [key, value] of Object.entries(input.destination.headers ?? {})) {
		headers[key] = substituteWebhookUrlPlaceholder(value, input.webhookUrl)
	}
	const body =
		input.destination.body === undefined
			? undefined
			: substituteWebhookUrlPlaceholder(
					input.destination.body,
					input.webhookUrl,
				)
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
		waitUntil: input.waitUntil,
	})
	return sendAuthorizedApplyRequest({
		url,
		method: input.destination.method ?? 'POST',
		headers,
		body,
		authorization: auth.authorization,
		retryAuthorization: auth.retryAuthorization,
		secrets: collectWebhookCredentialSecrets({
			url: input.webhookUrl,
			urlSecret: input.urlSecret,
		}),
	})
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
		waitUntil: input.waitUntil,
	})
	const secrets = collectWebhookCredentialSecrets({
		url: input.webhookUrl,
		urlSecret: input.urlSecret,
	})
	if (hookSecret) secrets.push(hookSecret)
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
		case 'https':
			result = await dispatchHttpsApply({
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
		default: {
			const exhaustive: never = input.destination
			throw new Error(
				`Unhandled webhook apply destination: ${String(exhaustive)}`,
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
