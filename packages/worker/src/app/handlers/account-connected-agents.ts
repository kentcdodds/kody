import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { enum_, object, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
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
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import { type routes } from '#universal/routes.ts'

export async function loadAccountConnectedAgentsData(input: {
	env: Env
	stableUserId: string
}): Promise<AccountConnectedAgentsLoaderData> {
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
	const state = await loadInboundMcpConnectionState(helpers, input.stableUserId)
	await maybeEvaluateSecondAgentStandardGift({
		db: input.env.APP_DB,
		stableUserId: input.stableUserId,
		uniqueClientCount: state.uniqueClientCount,
		listingFailed: state.listingFailed,
	})
	return {
		ok: true,
		agents: state.agents,
	}
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
						stableUserId: user.mcpUser.userId,
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
					stableUserId: user.mcpUser.userId,
				}),
			)
		},
	} satisfies Action<typeof routes.accountConnectedAgentsApi>
}

const revokeSchema = object({
	intent: enum_(['revoke'] as const),
	clientId: string(),
})
