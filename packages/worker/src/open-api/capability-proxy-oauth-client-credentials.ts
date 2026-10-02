import { executeGatewayFetch } from '#mcp/fetch-gateway.ts'
import {
	oauthClientCredentials,
	type OAuthClientCredentialsInput,
} from '#mcp/execute-modules/kody-runtime-utils.ts'
import { type ApiInvocationContext } from './context.ts'
import { invalidRequest } from './errors.ts'

/**
 * CapabilityProxy bridge for local `oauthClientCredentials`: origin expands
 * secret placeholders through the fetch gateway (same as cloud execute), so
 * client id/secret values never enter local workerd.
 */

export function parseCapabilityProxyOauthClientCredentialsArgs(
	args: ReadonlyArray<unknown>,
): OAuthClientCredentialsInput {
	const first = args[0]
	if (first == null || typeof first !== 'object' || Array.isArray(first)) {
		throw invalidRequest(
			'oauthClientCredentials requires a single object argument: { tokenUrl, clientIdSecret, clientSecretSecret, ... }.',
		)
	}
	const record = first as Record<string, unknown>
	const tokenUrl = record.tokenUrl
	if (
		!(typeof tokenUrl === 'string' && tokenUrl.trim()) &&
		!(tokenUrl instanceof URL)
	) {
		throw invalidRequest(
			'oauthClientCredentials requires a non-empty tokenUrl string or URL.',
		)
	}
	const clientIdSecret =
		typeof record.clientIdSecret === 'string'
			? record.clientIdSecret.trim()
			: ''
	const clientSecretSecret =
		typeof record.clientSecretSecret === 'string'
			? record.clientSecretSecret.trim()
			: ''
	if (!clientIdSecret || !clientSecretSecret) {
		throw invalidRequest(
			'oauthClientCredentials requires clientIdSecret and clientSecretSecret.',
		)
	}
	const authStyle = record.authStyle
	if (authStyle != null && authStyle !== 'basic') {
		throw invalidRequest(
			`Unsupported OAuth client_credentials authStyle "${String(authStyle)}".`,
		)
	}
	const scope =
		typeof record.scope === 'string' || record.scope == null
			? (record.scope as OAuthClientCredentialsInput['scope'])
			: undefined
	const body =
		record.body != null &&
		typeof record.body === 'object' &&
		!Array.isArray(record.body)
			? Object.fromEntries(
					Object.entries(record.body as Record<string, unknown>).flatMap(
						([key, value]) =>
							typeof value === 'string' ? [[key, value] as const] : [],
					),
				)
			: undefined
	const headers =
		record.headers != null &&
		typeof record.headers === 'object' &&
		!Array.isArray(record.headers)
			? Object.fromEntries(
					Object.entries(record.headers as Record<string, unknown>).flatMap(
						([key, value]) =>
							typeof value === 'string' ? [[key, value] as const] : [],
					),
				)
			: undefined
	return {
		tokenUrl: tokenUrl as string | URL,
		clientIdSecret,
		clientSecretSecret,
		...(authStyle === 'basic' ? { authStyle: 'basic' as const } : {}),
		...(scope !== undefined ? { scope } : {}),
		...(body ? { body } : {}),
		...(headers ? { headers } : {}),
	}
}

export async function runCapabilityProxyOauthClientCredentials(input: {
	ctx: ApiInvocationContext
	args: ReadonlyArray<unknown>
}) {
	const call = parseCapabilityProxyOauthClientCredentialsArgs(input.args)
	const user = input.ctx.callerContext.user
	if (!user) {
		throw invalidRequest(
			'oauthClientCredentials requires an authenticated user.',
		)
	}
	const existingStorage = input.ctx.callerContext.storageContext
	const storageContext = {
		sessionId: existingStorage?.sessionId ?? null,
		appId: existingStorage?.appId ?? null,
		packageId: existingStorage?.packageId ?? null,
		storageId: existingStorage?.storageId ?? null,
	}
	const gatewayFetch: typeof fetch = async (requestInput, init) =>
		executeGatewayFetch({
			env: input.ctx.env,
			props: {
				baseUrl: input.ctx.callerContext.baseUrl,
				userId: user.userId,
				email: user.email,
				storageContext,
			},
			request: new Request(requestInput, init),
			...(input.ctx.waitUntil ? { waitUntil: input.ctx.waitUntil } : {}),
		})

	return await oauthClientCredentials(call, { fetch: gatewayFetch })
}
