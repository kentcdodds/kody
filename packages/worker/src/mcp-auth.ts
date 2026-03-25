import {
	type OAuthHelpers,
	type TokenSummary,
} from '@cloudflare/workers-oauth-provider'
import { createMcpCallerContext, type McpServerProps } from './mcp/context.ts'
import { ensureBuiltinSkillTemplatesForUser } from '#mcp/skills/builtin-skill-templates.ts'
import { oauthScopes } from './oauth-handlers.ts'

export const mcpResourcePath = '/mcp'
export const protectedResourceMetadataPath =
	'/.well-known/oauth-protected-resource'
const builtinTemplateSeedCooldownMs = 5 * 60 * 1000
const builtinTemplateSeedMaxUsers = 1000
const builtinTemplateSeedByUser = new Map<string, number>()

function recordBuiltinTemplateSeed(userId: string, seededAt: number) {
	if (builtinTemplateSeedByUser.has(userId)) {
		builtinTemplateSeedByUser.delete(userId)
	}
	builtinTemplateSeedByUser.set(userId, seededAt)
	while (builtinTemplateSeedByUser.size > builtinTemplateSeedMaxUsers) {
		const oldestKey = builtinTemplateSeedByUser.keys().next().value
		if (!oldestKey) break
		builtinTemplateSeedByUser.delete(oldestKey)
	}
}

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

export function handleProtectedResourceMetadata(request: Request) {
	const url = new URL(request.url)
	return new Response(
		JSON.stringify(buildProtectedResourceMetadata(url.origin)),
		{
			headers: { 'Content-Type': 'application/json' },
		},
	)
}

function buildWwwAuthenticateHeader(origin: string) {
	const resourceMetadata = `${origin}${protectedResourceMetadataPath}`
	const scope =
		oauthScopes.length > 0 ? ` scope="${oauthScopes.join(' ')}"` : ''
	return `Bearer resource_metadata="${resourceMetadata}"${scope}`
}

function createUnauthorizedResponse(requestUrl: URL) {
	return new Response(null, {
		status: 401,
		headers: {
			'WWW-Authenticate': buildWwwAuthenticateHeader(requestUrl.origin),
		},
	})
}

function audienceMatches(
	audience: string | Array<string> | undefined,
	requestUrl: URL,
) {
	if (!audience) return false
	const allowed = Array.isArray(audience) ? audience : [audience]
	const origin = requestUrl.origin
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
	const authHeader = request.headers.get('Authorization')
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return createUnauthorizedResponse(url)
	}

	const token = authHeader.slice('Bearer '.length).trim()
	if (!token) {
		return createUnauthorizedResponse(url)
	}

	const helpers = (env as OAuthEnv).OAUTH_PROVIDER
	if (!helpers) {
		return createUnauthorizedResponse(url)
	}

	const tokenSummary = await helpers.unwrapToken(token)
	if (!tokenSummary || !audienceMatches(tokenSummary.audience, url)) {
		return createUnauthorizedResponse(url)
	}

	const context = ctx as OAuthExecutionContext
	const props: OAuthContextProps = createMcpCallerContext({
		baseUrl: url.origin,
		user: tokenSummary.grant.props ?? null,
		homeConnectorId: 'default',
	})
	if (props.user?.userId) {
		const now = Date.now()
		const lastSeededAt = builtinTemplateSeedByUser.get(props.user.userId)
		if (lastSeededAt && now - lastSeededAt < builtinTemplateSeedCooldownMs) {
			context.props = props
			return fetchMcp(
				request,
				env,
				context as ExecutionContext<OAuthContextProps>,
			)
		}
		try {
			await ensureBuiltinSkillTemplatesForUser(env, props.user.userId)
		} catch (error) {
			console.warn('Failed to ensure builtin MCP skill templates', {
				userId: props.user.userId,
				error: error instanceof Error ? error.message : String(error),
			})
		} finally {
			recordBuiltinTemplateSeed(props.user.userId, now)
		}
	}
	context.props = props

	return fetchMcp(request, env, context as ExecutionContext<OAuthContextProps>)
}
