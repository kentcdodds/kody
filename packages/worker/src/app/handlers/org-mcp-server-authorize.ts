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
import {
	createMcpServerAuthorizeConsentToken,
	verifyMcpServerAuthorizeConsentToken,
} from '#worker/mcp-client/authorize-consent.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import { getMcpServerSettingById } from '#worker/mcp-client/settings-service.ts'
import { type McpServerPendingAuthorization } from '#worker/mcp-client/types.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { type McpServerAuthorizeLoaderData } from '#universal/loader-data.ts'
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

/**
 * Resolve the signed-in member, the organization in the URL, and the server
 * it owns. Returns the response to send instead when any of them is refused.
 */
async function loadConsentContext(input: {
	env: Env
	request: Request
	params: AuthorizeParams
}): Promise<ConsentContext | Response> {
	const { env, request, params } = input
	const user = await readAuthenticatedAppUser(request, env)
	if (!user) return redirectToLogin(request)
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
		return renderAppPage({
			request,
			env,
			title: denial ?? 'Organization unavailable',
			notFound: true,
			status: 404,
		})
	}
	try {
		await authorize({ env, request: user.request }, 'integration:write')
	} catch (error) {
		if (!(error instanceof AuthorizationError)) throw error
		return renderAppPage({
			request,
			env,
			title: 'MCP server authorization unavailable',
			notFound: true,
			status: 403,
		})
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
	if (!setting) {
		return renderAppPage({
			request,
			env,
			title: 'MCP server not found',
			notFound: true,
			status: 404,
		})
	}
	const hub = createMcpClientHubClient({ env, userId: ownerId, waitUntil })
	const pending = await hub.readPendingAuthorization({ serverId: setting.id })
	return {
		user,
		orgSlug: resolution.org.slug ?? params.orgSlug,
		setting,
		pending,
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

async function renderConsentPage(input: {
	env: Env
	request: Request
	context: ConsentContext
	error?: string | null
	status?: number
}) {
	const { env, request, context } = input
	const { pending } = context
	const mcpServerAuthorize: McpServerAuthorizeLoaderData = {
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
	return renderAppPage({
		request,
		env,
		title: `Authorize ${context.setting.name}`,
		loaderData: { mcpServerAuthorize },
		status: input.status,
	})
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
			if (context instanceof Response) return context
			return renderConsentPage({ env, request, context })
		},
	} satisfies Action<typeof routes.orgMcpServerAuthorize>
}

/**
 * Continue on the consent page. The form token must match this person, org,
 * server, and pending authorization before the browser goes to the provider.
 */
export function createOrgMcpServerAuthorizePostHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, params }) {
			const context = await loadConsentContext({ env, request, params })
			if (context instanceof Response) return context
			const form = await request.formData().catch(() => null)
			const token = form?.get('_csrf')
			const { pending } = context
			if (!pending) {
				return renderConsentPage({
					env,
					request,
					context,
					error: notPendingMessage,
					status: 409,
				})
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
				return renderConsentPage({
					env,
					request,
					context,
					error: expiredFormMessage,
					status: 403,
				})
			}
			return new Response(null, {
				status: 303,
				headers: {
					Location: pending.authorizationUrl,
					'Cache-Control': 'private, no-store',
					// Providers that allowlist origins on Referer must not see Kody's.
					'Referrer-Policy': 'no-referrer',
				},
			})
		},
	} satisfies Action<typeof routes.orgMcpServerAuthorizePost>
}
