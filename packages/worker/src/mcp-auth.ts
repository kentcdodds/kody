import {
	type OAuthHelpers,
	type TokenSummary,
} from '@cloudflare/workers-oauth-provider'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { createMcpCallerContext, type McpServerProps } from './mcp/context.ts'
import { oauthScopes } from './oauth-handlers.ts'

export const mcpResourcePath = '/mcp'
export const protectedResourceMetadataPath =
	'/.well-known/oauth-protected-resource'

type OAuthEnv = Env & {
	OAUTH_PROVIDER?: OAuthHelpers
}

type OAuthContextProps = McpServerProps & {
	user?: TokenSummary['grant']['props'] | null
}

type OAuthExecutionContext = ExecutionContext & {
	props?: OAuthContextProps
}

export function buildProtectedResourceMetadata(origin: string) {
	return {
		resource: `${origin}${mcpResourcePath}`,
		authorization_servers: [origin],
		scopes_supported: oauthScopes,
	}
}

export function isProtectedResourceMetadataRequest(pathname: string) {
	return (
		pathname === protectedResourceMetadataPath ||
		pathname === `${protectedResourceMetadataPath}${mcpResourcePath}`
	)
}

export function handleProtectedResourceMetadata(request: Request, env?: Env) {
	const origin = getAppBaseUrl({
		env: env ?? {},
		requestUrl: request.url,
	})
	return new Response(JSON.stringify(buildProtectedResourceMetadata(origin)), {
		headers: { 'Content-Type': 'application/json' },
	})
}

function buildWwwAuthenticateHeader(origin: string) {
	const resourceMetadata = `${origin}${protectedResourceMetadataPath}`
	const scope =
		oauthScopes.length > 0 ? ` scope="${oauthScopes.join(' ')}"` : ''
	return `Bearer resource_metadata="${resourceMetadata}"${scope}`
}

function createUnauthorizedResponse(origin: string) {
	return new Response(null, {
		status: 401,
		headers: {
			'WWW-Authenticate': buildWwwAuthenticateHeader(origin),
		},
	})
}

function audienceMatches(
	audience: string | Array<string> | undefined,
	origin: string,
) {
	if (!audience) return false
	const allowed = Array.isArray(audience) ? audience : [audience]
	const resourcePath = `${origin}${mcpResourcePath}`
	return allowed.some((value) => value === origin || value === resourcePath)
}

export async function handleMcpRequest({
	request,
	env,
	ctx,
	fetchMcp,
}: {
	request: Request
	env: Env
	ctx: ExecutionContext
	fetchMcp: CustomExportedHandler<OAuthContextProps>['fetch']
}) {
	const url = new URL(request.url)
	const origin = getAppBaseUrl({
		env,
		requestUrl: url,
	})
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return createUnauthorizedResponse(origin)
	}

	const token = authHeader.slice('Bearer '.length).trim()
	if (!token) {
		return createUnauthorizedResponse(origin)
	}

	const helpers = (env as OAuthEnv).OAUTH_PROVIDER
	if (!helpers) {
		return createUnauthorizedResponse(origin)
	}

	const tokenSummary = await helpers.unwrapToken(token)
	if (!tokenSummary || !audienceMatches(tokenSummary.audience, origin)) {
		return createUnauthorizedResponse(origin)
	}

	const context = ctx as OAuthExecutionContext
	const props: OAuthContextProps = createMcpCallerContext({
		baseUrl: origin,
		user: tokenSummary.grant.props ?? null,
		homeConnectorId: 'default',
	})
	context.props = props

	return fetchMcp(request, env, context as ExecutionContext<OAuthContextProps>)
}
