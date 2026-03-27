import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	buildSecretHostApprovalUrl,
	createSecretHostApprovalToken,
} from '#mcp/secrets/host-approval.ts'
import {
	buildSecretPlaceholder,
	parseSecretPlaceholders,
	replaceSecretPlaceholders,
	type ReferencedSecret,
} from '#mcp/secrets/placeholders.ts'
import {
	createMissingSecretMessage,
	fetchSecretAuthRequiredMessage,
} from '#mcp/secrets/errors.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import { resolveSecret, type ResolvedSecret } from '#mcp/secrets/service.ts'
import { type SecretContext } from '#mcp/secrets/types.ts'

type FetchGatewayProps = {
	baseUrl: string
	userId: string | null
	secretContext: SecretContext | null
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
	const replacements = new Map<string, string>()
	const resolvedSecrets: Array<{
		referenced: ReferencedSecret
		resolved: ResolvedSecret
	}> = []
	const referencedSecrets = collectReferencedSecrets([
		input.request.url,
		...Array.from(headers.values()),
		requestBody,
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
			secretContext: input.props.secretContext,
		})
		if (!resolved.found || typeof resolved.value !== 'string') {
			throw new Error(createMissingSecretMessage(referenced.name))
		}
		const placeholder = buildSecretPlaceholder(referenced)
		replacements.set(placeholder, resolved.value)
		resolvedSecrets.push({ referenced, resolved })
	}
	const nextUrl = replaceSecretPlaceholders(input.request.url, replacements)
	let requestedHost = ''
	if (hasReferencedSecrets) {
		try {
			requestedHost = new URL(nextUrl).hostname
		} catch {
			throw new Error(
				'Unable to resolve the request host after secret expansion.',
			)
		}
		const normalizedHost = normalizeHost(requestedHost)
		for (const { referenced, resolved } of resolvedSecrets) {
			const allowedForHost = resolved.allowedHosts.includes(normalizedHost)
			if (allowedForHost) continue
			const approvalToken = await createSecretHostApprovalToken(input.env, {
				userId: input.props.userId!,
				name: referenced.name,
				scope: resolved.scope ?? referenced.scope ?? 'user',
				requestedHost,
				secretContext: input.props.secretContext,
			})
			const approvalUrl = buildSecretHostApprovalUrl({
				baseUrl: input.props.baseUrl,
				token: approvalToken,
				name: referenced.name,
				scope: resolved.scope ?? referenced.scope ?? 'user',
				requestedHost,
				secretContext: input.props.secretContext,
			})
			throw new Error(
				`Secret "${referenced.name}" is not allowed for host "${requestedHost}". If this request is expected, ask the user whether this host should be added to the secret's allowed hosts: ${approvalUrl}`,
			)
		}
	}
	for (const [key, value] of Array.from(headers.entries())) {
		headers.set(key, replaceSecretPlaceholders(value, replacements))
	}
	const nextBody =
		requestBody == null
			? undefined
			: replaceSecretPlaceholders(requestBody, replacements)
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

function ensureFetchAllowed(props: FetchGatewayProps) {
	if (!props.userId) {
		throw new Error(fetchSecretAuthRequiredMessage)
	}
}

function collectReferencedSecrets(values: Array<string | null | undefined>) {
	const deduped = new Map<string, ReferencedSecret>()
	for (const value of values) {
		if (!value) continue
		for (const referenced of parseSecretPlaceholders(value)) {
			deduped.set(buildSecretPlaceholder(referenced), referenced)
		}
	}
	return Array.from(deduped.values())
}

async function readRequestBody(request: Request) {
	if (!shouldSendBody(request.method)) return null
	return request.text()
}

function shouldSendBody(method: string) {
	return method !== 'GET' && method !== 'HEAD'
}
