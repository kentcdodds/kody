import { type Action } from 'remix/router'
import {
	personalOrgId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { isSecureRequest } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadRequestOrgResolution,
	type RequestOrgResolution,
} from '#app/org-request-binding.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { createAccountActivityHandler } from '#app/handlers/account-activity.ts'
import { createAccountConnectionsHandler } from '#app/handlers/account-connected-agents.ts'
import { createAccountEmailHandler } from '#app/handlers/account-email.ts'
import { createAccountIntegrationsHandler } from '#app/handlers/account-integrations.ts'
import { createAccountJobsHandler } from '#app/handlers/account-jobs.ts'
import { createAccountMcpServersHandler } from '#app/handlers/account-mcp-servers.ts'
import { createAccountMemoriesHandler } from '#app/handlers/account-memories.ts'
import { createAccountSecretProvidersHandler } from '#app/handlers/account-secret-providers.ts'
import { createAccountSecretsHandler } from '#app/handlers/account-secrets.ts'
import { createAccountValuesHandler } from '#app/handlers/account-values.ts'
import { createAccountWaitingHandler } from '#app/handlers/account-waiting.ts'
import { createAccountWebhooksHandler } from '#app/handlers/account-webhooks.ts'
import { createAccountWorkflowsHandler } from '#app/handlers/account-workflows.ts'
import {
	createProfileApiHandler,
	createProfileHandler,
} from '#app/handlers/profile.tsx'
import { jsonResponse } from '#worker/json-response.ts'
import { loadOrgBindingForSlug } from '#worker/orgs/repo.ts'
import { serializeLastUsedOrgCookie } from '#universal/org-last-used-cookie.ts'
import {
	orgSectionKeysOnPerson,
	type OrgOwnedAccountSection,
} from '#universal/org-pages.ts'
import { type routes } from '#universal/routes.ts'

type SectionHandler = {
	handler: (ctx: never) => Response | Promise<Response>
}

function sectionHandler(
	env: Env,
	section: OrgOwnedAccountSection,
): SectionHandler {
	switch (section) {
		case 'activity':
			return createAccountActivityHandler(env)
		case 'connections':
			return createAccountConnectionsHandler(env)
		case 'email':
			return createAccountEmailHandler(env)
		case 'integrations':
			return createAccountIntegrationsHandler(env)
		case 'jobs':
			return createAccountJobsHandler(env)
		case 'mcp-servers':
			return createAccountMcpServersHandler(env)
		case 'memories':
			return createAccountMemoriesHandler(env)
		case 'packages':
			return createProfileHandler(env)
		case 'secret-providers':
			return createAccountSecretProvidersHandler(env)
		case 'secrets':
			return createAccountSecretsHandler(env)
		case 'values':
			return createAccountValuesHandler(env)
		case 'waiting':
			return createAccountWaitingHandler(env)
		case 'webhooks':
			return createAccountWebhooksHandler(env)
		case 'workflows':
			return createAccountWorkflowsHandler(env)
		default: {
			const exhaustive: never = section
			throw new Error(`Unhandled organization section: ${String(exhaustive)}`)
		}
	}
}

function sectionParams(
	section: OrgOwnedAccountSection,
	rest: string | undefined,
) {
	const parts = (rest ?? '').split('/').filter(Boolean)
	const first = parts[0]
	switch (section) {
		case 'activity':
			return first ? { runId: first } : {}
		case 'jobs':
			return first ? { jobId: first } : {}
		case 'workflows':
			return first ? { workflowId: first } : {}
		case 'memories':
			return first ? { memoryId: first } : {}
		case 'email':
			return first ? { messageId: first } : {}
		case 'values':
			return first && first !== 'new' ? { valueId: first } : {}
		case 'connections':
			return first === 'new' && parts[1] ? { agent: parts[1] } : {}
		case 'integrations':
			if (first === 'apps' && parts[1]) return { appSlug: parts[1] }
			if (first && first !== 'approve' && first !== 'apps') {
				return { integrationName: first }
			}
			return {}
		case 'mcp-servers':
			if (first && first !== 'new' && first !== 'logos' && first !== 'oauth') {
				return { serverId: first }
			}
			return {}
		case 'packages':
		case 'secret-providers':
		case 'secrets':
		case 'waiting':
		case 'webhooks':
			return {}
		default: {
			const exhaustive: never = section
			return exhaustive
		}
	}
}

/**
 * Why `/@slug/-/<section>` is closed to this person, or null when it is open.
 */
export function orgSectionDenial(
	resolution: RequestOrgResolution,
	personId: PersonId,
	section: OrgOwnedAccountSection,
): string | null {
	if (resolution === 'denied' || resolution === 'personal') {
		return 'Organization unavailable'
	}
	// A grant without a membership is not access to the whole workspace.
	// Connections only lists the viewer's own agents bound to this org, which
	// is how a collaborator starts using what was shared with them.
	if (resolution.role == null && section !== 'connections') {
		return 'Organization resources unavailable'
	}
	if (
		orgSectionKeysOnPerson(section) &&
		resolution.org.id !== personalOrgId(personId)
	) {
		return 'Organization resources unavailable'
	}
	return null
}

export function createOrgSectionHandler(
	env: Env,
	section: OrgOwnedAccountSection,
) {
	const inner = sectionHandler(env, section)
	return {
		middleware: [],
		async handler(ctx: {
			request: Request
			params: { orgSlug?: string; rest?: string }
		}) {
			const user = await readAuthenticatedAppUser(ctx.request, env)
			if (!user) return redirectToLogin(ctx.request)
			const resolution = await loadRequestOrgResolution(
				ctx.request,
				env,
				user.mcpUser.userId,
			)
			const denial = orgSectionDenial(resolution, user.mcpUser.userId, section)
			if (denial || typeof resolution === 'string') {
				return renderAppPage({
					request: ctx.request,
					env,
					title: denial ?? 'Organization unavailable',
					notFound: true,
					status: 404,
				})
			}
			const slug = resolution.org.slug ?? ctx.params.orgSlug ?? ''
			const params = {
				...ctx.params,
				...sectionParams(section, ctx.params.rest),
				// Profile lookup is by users.username, which can diverge from
				// the immutable personal-org slug after a rename.
				...(section === 'packages' ? { username: user.username } : {}),
			}
			const response = await inner.handler({
				request: ctx.request,
				params,
				url: new URL(ctx.request.url),
			} as never)
			if (!slug) return response
			const headers = new Headers(response.headers)
			headers.append(
				'Set-Cookie',
				serializeLastUsedOrgCookie({
					slug,
					secure: isSecureRequest(ctx.request),
				}),
			)
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			})
		},
	}
}

/**
 * JSON for the workspace Repositories page, behind the same gate as
 * `/@slug/-/packages`. The list is the signed-in person's own inventory, looked
 * up by their current username because the personal-org slug does not follow
 * a username change.
 */
export function createOrgPackagesApiHandler(env: Env) {
	const profileApi = createProfileApiHandler(env)
	return {
		middleware: [],
		async handler({ request, params }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized' }, 401)
			}
			const binding = await loadOrgBindingForSlug(
				env.APP_DB,
				user.mcpUser.userId,
				params.orgSlug,
			)
			const denial = orgSectionDenial(
				binding ?? 'denied',
				user.mcpUser.userId,
				'packages',
			)
			if (denial) return jsonResponse({ ok: false, error: denial }, 404)
			return profileApi.handler({
				request,
				params: { username: user.username },
				url: new URL(request.url),
			} as never)
		},
	} satisfies Action<typeof routes.orgPackagesApi>
}
