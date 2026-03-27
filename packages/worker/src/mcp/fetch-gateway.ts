import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	buildSecretHostApprovalUrl,
	createSecretHostApprovalToken,
} from '#mcp/secrets/host-approval.ts'
import { resolveSecretForHost } from '#mcp/secrets/service.ts'
import { type SecretContext, type SecretScope } from '#mcp/secrets/types.ts'

const secretPlaceholderRegex =
	/\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=(session|app|user))?\}\}/g

type FetchGatewayProps = {
	baseUrl: string
	userId: string | null
	secretContext: SecretContext | null
}
export type { FetchGatewayProps }

type ReferencedSecret = {
	name: string
	scope: SecretScope | null
}

export class CodemodeFetchGateway extends WorkerEntrypoint<Env, FetchGatewayProps> {
	async fetch(request: Request) {
		const targetUrl = new URL(request.url)
		const transformed = await expandSecretPlaceholders({
			request,
			targetHost: targetUrl.hostname,
			props: this.ctx.props,
			env: this.env,
		})
		return fetch(transformed)
	}
}

export async function expandSecretPlaceholders(input: {
	request: Request
	targetHost: string
	props: FetchGatewayProps
	env: Pick<Env, 'APP_DB' | 'COOKIE_SECRET'>
}) {
	ensureFetchAllowed(input.props)
	const headers = new Headers(input.request.headers)
	const requestBody = await readRequestBody(input.request)
	const replacements = new Map<string, string>()
	const referencedSecrets = collectReferencedSecrets([
		input.request.url,
		...Array.from(headers.values()),
		requestBody,
	])
	for (const referenced of referencedSecrets) {
		const resolved = await resolveSecretForHost({
			env: input.env,
			userId: input.props.userId!,
			name: referenced.name,
			scope: referenced.scope,
			secretContext: input.props.secretContext,
			host: input.targetHost,
		})
		if (!resolved.found || typeof resolved.value !== 'string') {
			throw new Error(`Secret "${referenced.name}" was not found.`)
		}
		if ('allowedForHost' in resolved && resolved.allowedForHost !== true) {
			const approvalToken = await createSecretHostApprovalToken(input.env, {
				userId: input.props.userId!,
				name: referenced.name,
				scope: resolved.scope ?? referenced.scope ?? 'user',
				requestedHost: input.targetHost,
				secretContext: input.props.secretContext,
			})
			const approvalUrl = buildSecretHostApprovalUrl(
				input.props.baseUrl,
				approvalToken,
			)
			throw new Error(
				`Secret "${referenced.name}" is not allowed for host "${input.targetHost}". If this request is expected, ask the user whether this host should be added to the secret's allowed hosts: ${approvalUrl}`,
			)
		}
		const placeholder = buildSecretPlaceholder(referenced)
		replacements.set(placeholder, resolved.value)
	}
	const nextUrl = replaceSecretPlaceholders(input.request.url, replacements)
	for (const [key, value] of headers.entries()) {
		headers.set(key, replaceSecretPlaceholders(value, replacements))
	}
	const nextBody =
		requestBody == null
			? undefined
			: replaceSecretPlaceholders(requestBody, replacements)
	return new Request(nextUrl, {
		method: input.request.method,
		headers,
		body: shouldSendBody(input.request.method) ? nextBody : undefined,
		redirect: input.request.redirect,
	})
}

function ensureFetchAllowed(props: FetchGatewayProps) {
	if (!props.userId) {
		throw new Error(
			'Network requests that use secret placeholders require an authenticated user.',
		)
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

function parseSecretPlaceholders(value: string) {
	const secrets: Array<ReferencedSecret> = []
	for (const match of value.matchAll(secretPlaceholderRegex)) {
		const name = match[1]?.trim()
		if (!name) continue
		const scope = match[2]
		secrets.push({
			name,
			scope:
				scope === 'app' || scope === 'session' || scope === 'user'
					? scope
					: null,
		})
	}
	return secrets
}

function buildSecretPlaceholder(secret: ReferencedSecret) {
	return secret.scope
		? `{{secret:${secret.name}|scope=${secret.scope}}}`
		: `{{secret:${secret.name}}}`
}

function replaceSecretPlaceholders(
	value: string,
	replacements: ReadonlyMap<string, string>,
) {
	let nextValue = value
	for (const [placeholder, secretValue] of replacements.entries()) {
		nextValue = nextValue.replaceAll(placeholder, secretValue)
	}
	return nextValue
}

async function readRequestBody(request: Request) {
	if (!shouldSendBody(request.method)) return null
	return request.text()
}

function shouldSendBody(method: string) {
	return method !== 'GET' && method !== 'HEAD'
}
