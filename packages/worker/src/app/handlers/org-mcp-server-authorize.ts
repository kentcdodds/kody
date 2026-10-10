import { waitUntil } from 'cloudflare:workers'
import { type Action } from 'remix/router'
import { redirectToLogin } from '#app/auth-redirect.ts'
import {
	type AuthenticatedAppUser,
	readAuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { orgSectionDenial } from '#app/handlers/org-section.ts'
import { loadRequestOrgResolution } from '#app/org-request-binding.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import {
	authorize,
	AuthorizationError,
} from '#worker/authorization/authorize.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	createMcpServerAuthorizeConsentToken,
	verifyMcpServerAuthorizeConsentToken,
} from '#worker/mcp-client/authorize-consent.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import { getMcpServerSettingById } from '#worker/mcp-client/settings-service.ts'
import { type McpServerPendingAuthorization } from '#worker/mcp-client/types.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	type McpServerAuthorizeContinueResponse,
	type McpServerAuthorizeLoaderData,
} from '#universal/loader-data.ts'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import { type routes } from '#universal/routes.ts'

type AuthorizeParams = { orgSlug: string; serverId: string }

const expiredFormMessage =
	'This approval form expired. Review the details and click Continue again.'
const notPendingMessage =
	'This server is not waiting for approval. Reconnect it to start a new authorization.'

type ConsentContext = {
	user: AuthenticatedAppUser
	orgSlug: string
	setting: { id: string; name: string; url: string }
	pending: McpServerPendingAuthorization | null
}

type ConsentRefusal =
	| { kind: 'signed-out' }
	| { kind: 'not-found'; title: string }
	| { kind: 'forbidden'; title: string }

/**
 * Resolve the signed-in member, the organization in the URL, and the server
 * it owns, or why this request may not see them.
 */
async function loadConsentContext(input: {
	env: Env
	request: Request
	params: AuthorizeParams
}): Promise<ConsentContext | ConsentRefusal> {
	const { env, request, params } = input
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return { kind: 'signed-out' }
	const resolution = await loadRequestOrgResolution(
		request,
		env,
		user.mcpUser.userId,
	)
	const denial = orgSectionDenial(
		resolution,
		user.mcpUser.userId,
		'mcp-servers',
	)
	if (denial || typeof resolution === 'string') {
		return { kind: 'not-found', title: denial ?? 'Organization unavailable' }
	}
	try {
		await authorize({ env, request: user.request }, 'integration:write')
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return { kind: 'forbidden', title: 'MCP server authorization unavailable' }
	}
	const ownerId = ownerIdFromCaller({
		request: user.request,
		user: user.mcpUser,
	})
	const setting = await getMcpServerSettingById({
		env,
		userId: ownerId,
		id: params.serverId,
	})
	if (!setting) return { kind: 'not-found', title: 'MCP server not found' }
	const hub = createMcpClientHubClient({ env, userId: ownerId, waitUntil })
	const pending = await hub.readPendingAuthorization({ serverId: setting.id })
	return {
		user,
		orgSlug: resolution.org.slug ?? params.orgSlug,
		setting,
		pending,
	}
}

function isConsentRefusal(
	value: ConsentContext | ConsentRefusal,
): value is ConsentRefusal {
	return 'kind' in value
}

function refusalStatus(refusal: ConsentRefusal) {
	switch (refusal.kind) {
		case 'signed-out':
			return 401
		case 'not-found':
			return 404
		case 'forbidden':
			return 403
		default: {
			const exhaustive: never = refusal
			throw new Error(`Unhandled consent refusal: ${String(exhaustive)}`)
		}
	}
}

function consentTokenBinding(
	context: ConsentContext,
	pending: McpServerPendingAuthorization,
) {
	return {
		personId: context.user.mcpUser.userId,
		orgId: context.user.request.org.id,
		serverId: context.setting.id,
		authorizationUrl: pending.authorizationUrl,
	}
}

async function buildConsentLoaderData(input: {
	env: Env
	context: ConsentContext
	error?: string | null
}): Promise<McpServerAuthorizeLoaderData> {
	const { env, context } = input
	const { pending } = context
	return {
		ok: true,
		orgSlug: context.orgSlug,
		serverId: context.setting.id,
		serverName: context.setting.name,
		serverUrl: context.setting.url,
		serverHref: orgSectionRestPath(
			context.orgSlug,
			'mcp-servers',
			context.setting.id,
		),
		pending: pending
			? {
					authorizationServerHost: new URL(pending.authorizationUrl).host,
					clientMode: pending.clientMode,
					csrfToken: await createMcpServerAuthorizeConsentToken({
						secret: env.COOKIE_SECRET,
						binding: consentTokenBinding(context, pending),
					}),
				}
			: null,
		error: input.error ?? null,
	}
}

/**
 * The page every MCP server `authUrl` opens. It names the server, the
 * authorization server host, and the client mode, and sends nobody to the
 * provider until they click Continue.
 */
export function createOrgMcpServerAuthorizeHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const context = await loadConsentContext({ env, request, params })
			if (isConsentRefusal(context)) {
				if (context.kind === 'signed-out') return redirectToLogin(request)
				return renderAppPage({
					request,
					env,
					title: context.title,
					notFound: true,
					status: refusalStatus(context),
				})
			}
			return renderAppPage({
				request,
				env,
				title: `Authorize ${context.setting.name}`,
				loaderData: {
					mcpServerAuthorize: await buildConsentLoaderData({ env, context }),
				},
			})
		},
	} satisfies Action<typeof routes.orgMcpServerAuthorize>
}

/**
 * Continue on the consent page. The form token must match this person, org,
 * server, and pending authorization before Kody hands back the provider URL.
 */
export function createOrgMcpServerAuthorizePostHandler(env: Env) {
	function respond(body: McpServerAuthorizeContinueResponse, status = 200) {
		return jsonResponse(body, {
			status,
			headers: { 'Cache-Control': 'private, no-store' },
		})
	}
	return {
		middleware: [],
		async handler({ request, params }) {
			const context = await loadConsentContext({ env, request, params })
			if (isConsentRefusal(context)) {
				return respond(
					{
						ok: false,
						error:
							context.kind === 'signed-out'
								? 'Sign in to Kody, then open this page again.'
								: context.title,
						consent: null,
					},
					refusalStatus(context),
				)
			}
			const form = await request.formData().catch(() => null)
			const token = form?.get('_csrf')
			const { pending } = context
			if (!pending) {
				return respond(
					{
						ok: false,
						error: notPendingMessage,
						consent: await buildConsentLoaderData({
							env,
							context,
							error: notPendingMessage,
						}),
					},
					409,
				)
			}
			const valid =
				typeof token === 'string' &&
				token.length > 0 &&
				(await verifyMcpServerAuthorizeConsentToken({
					secret: env.COOKIE_SECRET,
					token,
					binding: consentTokenBinding(context, pending),
				}))
			if (!valid) {
				return respond(
					{
						ok: false,
						error: expiredFormMessage,
						consent: await buildConsentLoaderData({
							env,
							context,
							error: expiredFormMessage,
						}),
					},
					403,
				)
			}
			return respond({ ok: true, authorizationUrl: pending.authorizationUrl })
		},
	} satisfies Action<typeof routes.orgMcpServerAuthorizePost>
}
