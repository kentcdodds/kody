import { type Action } from 'remix/router'
import { loadAccountCredentialsData } from '#app/account-credentials-data.ts'
import {
	type AuthenticatedAppUser,
	readAuthenticatedAppUser,
} from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { readNonEmptyTrimmedString } from '#app/request-body.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import {
	parseCredentialHostsInput,
	updateCredentialHosts,
} from '#worker/credentials/credential-hosts.ts'
import {
	credentialPermissionFamily,
	credentialResource,
	getOrgCredential,
	missingCredentialResource,
} from '#worker/credentials/credential-ids.ts'
import { jsonResponse } from '#worker/json-response.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	readCredentialListFilters,
	type SetCredentialHostsResponse,
} from '#universal/credentials-list.ts'
import { type routes } from '#universal/routes.ts'

/**
 * `/@slug/-/credentials`: every credential the org holds, in one list.
 * `/@slug/-/credentials/new` is the creation one-pager for the same org.
 */
export function createAccountCredentialsHandler(env: Env) {
	return {
		middleware: [],
		async handler({
			request,
			params,
		}: {
			request: Request
			params: { credentialId?: string }
		}) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) return user
			const creating = params.credentialId === 'new'
			const accountCredentials = await loadAccountCredentialsData({
				env,
				user,
				selectedId: creating ? null : (params.credentialId ?? null),
			})
			return renderAppPage({
				request,
				env,
				title: creating ? 'Add a credential' : 'Credentials',
				loaderData: { accountCredentials },
			})
		},
	}
}

/**
 * `POST {action: 'setHosts', credentialId, hosts}`: replaces the hosts a Key
 * or OAuth connection may be sent to. Website only, audited, and never takes
 * or returns a value.
 */
async function handleSetHosts(input: {
	env: Env
	user: AuthenticatedAppUser
	body: object
}) {
	const credentialId = readNonEmptyTrimmedString(input.body, 'credentialId')
	if (!credentialId) {
		return jsonResponse({ ok: false, error: 'Credential id is required.' }, 400)
	}
	const rawHosts = (input.body as Record<string, unknown>)['hosts']
	if (!Array.isArray(rawHosts)) {
		return jsonResponse({ ok: false, error: 'Hosts must be a list.' }, 400)
	}
	const parsed = parseCredentialHostsInput(rawHosts)
	if (!parsed.ok) {
		return jsonResponse({ ok: false, error: parsed.error }, 400)
	}
	const request = input.user.request
	const orgId = ownerIdFromCaller({ request, user: input.user.mcpUser })
	try {
		const credential = await getOrgCredential(
			input.env.APP_DB,
			orgId,
			credentialId,
		)
		if (!credential?.live) {
			await authorize(
				{ env: input.env, request },
				'secret:write',
				missingCredentialResource(request.org.id, credentialId),
			)
			return jsonResponse(
				{ ok: false, error: 'No credential with that id in this org.' },
				404,
			)
		}
		await authorize(
			{ env: input.env, request },
			`${credentialPermissionFamily(credential.kind)}:write`,
			credentialResource(request.org.id, credential),
		)
		const updated = await updateCredentialHosts({
			db: input.env.APP_DB,
			orgId,
			credentialId: credential.id,
			hosts: parsed.hosts,
			audit: orgAuditWriterFromRequest(input.env, request),
		})
		return jsonResponse({
			ok: true,
			...updated,
		} satisfies SetCredentialHostsResponse)
	} catch (error) {
		if (error instanceof AuthorizationError) {
			return jsonResponse({ ok: false, error: error.message }, 403)
		}
		if (error instanceof McpCallerError) {
			return jsonResponse({ ok: false, error: error.message }, 400)
		}
		throw error
	}
}

/**
 * `GET /account/credentials.json`: the request org's credentials list as
 * `CredentialListItem`s, plus what the website page needs. A fetch from an
 * `/@slug/-/…` page binds that org. Metadata only, never a value.
 */
export function createAccountCredentialsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			if (request.method !== 'GET' && request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			if (request.method === 'POST') {
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object') {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}
				const action = readNonEmptyTrimmedString(body, 'action')
				if (action === 'setHosts') {
					return handleSetHosts({ env, user, body })
				}
				return jsonResponse({ ok: false, error: 'Unknown action.' }, 400)
			}
			const params = new URL(request.url).searchParams
			return jsonResponse(
				await loadAccountCredentialsData({
					env,
					user,
					filters: readCredentialListFilters(params),
					selectedId: params.get('selected'),
				}),
			)
		},
	} satisfies Action<
		| typeof routes.accountCredentialsApi
		| typeof routes.accountCredentialsApiPost
	>
}
