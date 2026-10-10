import {
	personalOrgId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
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
import {
	countConnectedAgentEcosystems,
	hasSecondConnectedMcpClient,
} from '#universal/onboarding-agent-ecosystems.ts'
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
import { deleteMcpEventSubscriptionsForOauthClient } from '#mcp/events/subscriptions-repo.ts'
import { parseAccountConnectionsPathname } from '#universal/account-connections.ts'
import { type AccountConnectedAgentsLoaderData } from '#universal/loader-data.ts'
import { type routes } from '#universal/routes.ts'
import {
	loadConnectionProfilesForAccount,
	applyConnectionProfileMutation,
} from '#worker/connection-profiles/account.ts'

type ConnectedAgentsUser = {
	mcpUser: { userId: PersonId }
	emailVerified: boolean
	request: RequestContext
}

/**
 * Inbound agents are OAuth grants held by the signed-in person. The page org
 * (`request.org.id`) picks which of them to show: the ones approved for that
 * org. Connection profiles and the second-agent gift stay on the signup org.
 */
function connectedAgentsScope(user: ConnectedAgentsUser) {
	const personId = personalOrgId(user.mcpUser.userId)
	const orgId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	return { personId, orgId, personalOrg: orgId === personId }
}

export async function loadAccountConnectedAgentsData(input: {
	env: Env
	requestUrl: string | URL
	user: ConnectedAgentsUser
}): Promise<AccountConnectedAgentsLoaderData> {
	const { personId, orgId, personalOrg } = connectedAgentsScope(input.user)
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
	const state = await loadInboundMcpConnectionState(helpers, personId, {
		env: input.env,
		orgId,
	})
	if (
		personalOrg &&
		!state.listingFailed &&
		hasSecondConnectedMcpClient(state.agents)
	) {
		await maybeEvaluateSecondAgentStandardGift({
			db: input.env.APP_DB,
			stableUserId: personId,
			ecosystemCount: countConnectedAgentEcosystems(state.agents),
			listingFailed: state.listingFailed,
		})
	}
	return {
		ok: true,
		agents: state.agents,
		mcpServerUrl: input.user.emailVerified
			? buildMcpServerUrl({ env: input.env, requestUrl: input.requestUrl })
			: '',
		...(personalOrg
			? await loadConnectionProfilesForAccount({
					env: input.env,
					requestUrl: input.requestUrl,
					userId: personId,
					emailVerified: input.user.emailVerified,
				})
			: {
					connectionProfilesEnabled: false,
					connectionProfiles: [],
					connectionProfilePackageOptions: [],
				}),
	}
}

/**
 * `/account/connections`, `/account/connections/new`, and
 * `/account/connections/new/:agent` share one payload; the client renders
 * each pathname as its own page (the list does not wrap the add views).
 * An unknown agent segment is a 404 page.
 */
export function createAccountConnectionsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }: { request: Request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const view = parseAccountConnectionsPathname(
				new URL(request.url).pathname,
			)
			if (!view) {
				return renderAppPage({
					request,
					env,
					title: 'Connection not found',
					notFound: true,
					status: 404,
				})
			}

			const accountConnectedAgents = await loadAccountConnectedAgentsData({
				env,
				requestUrl: request.url,
				user,
			})
			// Titles come from the document-head registry so SPA navigation
			// between the list, grid, and per-agent views agrees with SSR.
			return renderAppPage({
				request,
				env,
				loaderData: { accountConnectedAgents },
			})
		},
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
						requestUrl: request.url,
						user,
					}),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (
				body &&
				typeof body === 'object' &&
				'intent' in body &&
				(body.intent === 'create' ||
					body.intent === 'update' ||
					body.intent === 'delete')
			) {
				if (!connectedAgentsScope(user).personalOrg) {
					return jsonResponse(
						{
							ok: false,
							error:
								'Connection profiles are only available in your personal organization.',
						},
						404,
					)
				}
				const mutation = await applyConnectionProfileMutation({
					env,
					requestUrl: request.url,
					userId: personalOrgId(user.mcpUser.userId),
					emailVerified: user.emailVerified,
					body,
				})
				if (!mutation.ok) {
					return jsonResponse(
						{ ok: false, error: mutation.error },
						mutation.status,
					)
				}
				const payload = await loadAccountConnectedAgentsData({
					env,
					requestUrl: request.url,
					user,
				})
				return jsonResponse({
					...payload,
					connectionProfiles: mutation.connectionProfiles,
					connectionProfilePackageOptions:
						mutation.connectionProfilePackageOptions,
				})
			}

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

			const { personId, orgId } = connectedAgentsScope(user)
			const revoked = await revokeConnectedMcpAgent({
				helpers,
				userId: personId,
				clientId: parsed.value.clientId.trim(),
				orgId,
				env,
			})
			if ('error' in revoked) {
				// Retry cleanup when grants are already gone but subscription
				// rows may have survived a prior partial revoke.
				if (!revoked.clientRemains) {
					await deleteMcpEventSubscriptionsForOauthClient({
						db: env.APP_DB,
						oauthClientId: parsed.value.clientId.trim(),
						userId: personId,
					})
				}
				return jsonResponse(
					{ ok: false, error: 'Connected agent not found.' },
					404,
				)
			}
			if (!revoked.clientRemains) {
				await deleteMcpEventSubscriptionsForOauthClient({
					db: env.APP_DB,
					oauthClientId: parsed.value.clientId.trim(),
					userId: personId,
				})
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
