import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { enum_, object, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { hasSecondConnectedMcpClient } from '#universal/connected-mcp-agents.ts'
import {
	loadInboundMcpConnectionState,
	revokeConnectedMcpAgent,
} from '#worker/connected-mcp-agents.ts'
import { maybeEvaluateSecondAgentStandardGift } from '#worker/entitlements/second-agent-standard-gift.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import {
	type OAuthGrantHelpers,
	type OAuthGrantListHelpers,
} from '#worker/oauth-grants.ts'
import { buildMcpServerUrl } from '#worker/onboarding-prompts.ts'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import { type routes } from '#universal/routes.ts'

type ConnectedAgentsUser = {
	mcpUser: { userId: string }
	emailVerified: boolean
}

export async function loadAccountConnectedAgentsData(input: {
	env: Env
	requestUrl: string | URL
	user: ConnectedAgentsUser
}): Promise<AccountConnectedAgentsLoaderData> {
	const stableUserId = input.user.mcpUser.userId
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
	const state = await loadInboundMcpConnectionState(helpers, stableUserId)
	if (
		!state.listingFailed &&
		hasSecondConnectedMcpClient(state.uniqueClientCount)
	) {
		await maybeEvaluateSecondAgentStandardGift({
			db: input.env.APP_DB,
			stableUserId,
			uniqueClientCount: state.uniqueClientCount,
			listingFailed: state.listingFailed,
		})
	}
	return {
		ok: true,
		agents: state.agents,
		mcpServerUrl: input.user.emailVerified
			? buildMcpServerUrl({ env: input.env, requestUrl: input.requestUrl })
			: '',
	}
}

export function createAccountConnectionsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountConnectedAgents = await loadAccountConnectedAgentsData({
				env,
				requestUrl: request.url,
				user,
			})
			return renderAppPage({
				request,
				env,
				title: 'Connections',
				loaderData: { accountConnectedAgents },
			})
		},
	} satisfies Action<typeof routes.accountConnections>
}

export function createAccountConnectedAgentsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountConnectedAgentsData({
						env,
						requestUrl: request.url,
						user,
					}),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			const parsed = parseSafe(revokeSchema, body)
			if (!parsed.success || parsed.value.intent !== 'revoke') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const helpers = await resolveOAuthHelpers<OAuthGrantHelpers>(env)
			if (!helpers) {
				return jsonResponse(
					{ ok: false, error: 'Connected agent listing is unavailable.' },
					503,
				)
			}

			const revoked = await revokeConnectedMcpAgent({
				helpers,
				userId: user.mcpUser.userId,
				clientId: parsed.value.clientId.trim(),
			})
			if ('error' in revoked) {
				return jsonResponse(
					{ ok: false, error: 'Connected agent not found.' },
					404,
				)
			}

			void logAuditEvent({
				db: auditDatabaseFromEnv(env),
				category: 'oauth',
				action: 'mcp_inbound_grant_revoke',
				result: 'success',
				email: user.email,
				ip: getRequestIp(request) ?? undefined,
				path: url.pathname,
				clientId: parsed.value.clientId.trim(),
			})
			return jsonResponse(
				await loadAccountConnectedAgentsData({
					env,
					requestUrl: request.url,
					user,
				}),
			)
		},
	} satisfies Action<typeof routes.accountConnectedAgentsApi>
}

const revokeSchema = object({
	intent: enum_(['revoke'] as const),
	clientId: string(),
})
