import { type Action } from 'remix/router'
import { loadAccountRemoteConnectorsData } from '#app/account-remote-connectors-data.ts'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	redirectToLogin,
	redirectToLoginWhenUnauthenticated,
} from '#app/auth-redirect.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import {
	deleteRemoteConnectorSetting,
	saveRemoteConnectorSetting,
} from '#worker/remote-connector/settings-service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export function createAccountRemoteConnectorsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { session } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return redirectToLoginWhenUnauthenticated(request, env)
			}

			const accountRemoteConnectors = await loadAccountRemoteConnectorsData({
				env,
				request,
				user,
			})
			return renderAppPage({
				request,
				env,
				title: 'Remote connectors',
				loaderData: { accountRemoteConnectors },
			})
		},
	} satisfies Action<typeof routes.accountRemoteConnectors>
}

export function createAccountRemoteConnectorsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountRemoteConnectorsData({
						env,
						request,
						user,
					}),
				)
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const action = readString(body, 'action')
			try {
				if (action === 'save') {
					return await handleSaveAction({
						env,
						user,
						body,
						request,
					})
				}
				if (action === 'delete') {
					return await handleDeleteAction({
						env,
						user,
						body,
						request,
					})
				}
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update remote connector settings.',
					},
					400,
				)
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<typeof routes.accountRemoteConnectorsApi>
}

async function handleSaveAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const saved = await saveRemoteConnectorSetting({
		env: input.env,
		userId: input.user.mcpUser.userId,
		id: readOptionalString(input.body, 'id'),
		kind: readString(input.body, 'kind'),
		instanceId: readString(input.body, 'instanceId'),
		enabled: readBoolean(input.body, 'enabled', true),
		attached: readBoolean(input.body, 'attached', true),
		sharedSecret: readOptionalString(input.body, 'sharedSecret'),
	})
	const payload = await loadAccountRemoteConnectorsData({
		env: input.env,
		request: input.request,
		user: input.user,
	})
	return jsonResponse({
		...payload,
		selectedConnectorId: saved.id,
	})
}

async function handleDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	request: Request
	body: object
}) {
	const id = readString(input.body, 'id')
	if (!id) {
		return jsonResponse(
			{ ok: false, error: 'Remote connector setting id is required.' },
			400,
		)
	}
	const deleted = await deleteRemoteConnectorSetting({
		env: input.env,
		userId: input.user.mcpUser.userId,
		id,
	})
	if (!deleted) {
		return jsonResponse(
			{ ok: false, error: 'Remote connector setting not found.' },
			404,
		)
	}
	return jsonResponse(
		await loadAccountRemoteConnectorsData({
			env: input.env,
			request: input.request,
			user: input.user,
		}),
	)
}

function readString(body: object, key: string) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'string' ? value.trim() : ''
}

function readOptionalString(body: object, key: string) {
	const value = readString(body, key)
	return value || null
}

function readBoolean(body: object, key: string, defaultValue: boolean) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'boolean' ? value : defaultValue
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
		},
	})
}
