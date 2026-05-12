import { type BuildAction } from 'remix/fetch-router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
import {
	deleteRemoteConnectorSetting,
	listRemoteConnectorSettingsWithSharedSecrets,
	saveRemoteConnectorSetting,
} from '#worker/remote-connector/settings-service.ts'
import { userScopedConnectorWebSocketUrl } from '@kody-internal/shared/remote-connectors.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

type AccountRemoteConnectorListItem = {
	id: string
	kind: string
	instanceId: string
	connectorUrl: string
	enabled: boolean
	attached: boolean
	hasSharedSecret: boolean
	sharedSecret: string
	createdAt: string
	updatedAt: string
}

type AccountRemoteConnectorsPayload = {
	ok: true
	email: string
	username: string
	connectorUrlOrigin: string
	connectors: Array<AccountRemoteConnectorListItem>
}

export function createAccountRemoteConnectorsHandler(_env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const response = render(Layout({ title: 'Remote connectors' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
		},
	} satisfies BuildAction<
		typeof routes.accountRemoteConnectors.method,
		typeof routes.accountRemoteConnectors.pattern
	>
}

export function createAccountRemoteConnectorsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}
			const connectorUrlOrigin = getConnectorUrlOrigin(request)

			if (request.method === 'GET') {
				return jsonResponse(
					await buildPayload({ env, user, connectorUrlOrigin }),
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
						connectorUrlOrigin,
					})
				}
				if (action === 'delete') {
					return await handleDeleteAction({
						env,
						user,
						body,
						connectorUrlOrigin,
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
	} satisfies BuildAction<
		typeof routes.accountRemoteConnectorsApi.method,
		typeof routes.accountRemoteConnectorsApi.pattern
	>
}

async function handleSaveAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	connectorUrlOrigin: string
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
	const payload = await buildPayload({
		env: input.env,
		user: input.user,
		connectorUrlOrigin: input.connectorUrlOrigin,
	})
	return jsonResponse({
		...payload,
		selectedConnectorId: saved.id,
	})
}

async function handleDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	connectorUrlOrigin: string
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
		await buildPayload({
			env: input.env,
			user: input.user,
			connectorUrlOrigin: input.connectorUrlOrigin,
		}),
	)
}

async function buildPayload(input: {
	env: Env
	user: AuthenticatedUser
	connectorUrlOrigin: string
}): Promise<AccountRemoteConnectorsPayload> {
	const connectors = await listRemoteConnectorSettingsWithSharedSecrets({
		env: input.env,
		userId: input.user.mcpUser.userId,
	})
	return {
		ok: true,
		email: input.user.email,
		username: input.user.username,
		connectorUrlOrigin: input.connectorUrlOrigin,
		connectors: connectors.map((connector) => ({
			...connector,
			connectorUrl: userScopedConnectorWebSocketUrl({
				origin: input.connectorUrlOrigin,
				username: input.user.username,
				kind: connector.kind,
				instanceId: connector.instanceId,
			}),
		})),
	}
}

function getConnectorUrlOrigin(request: Request) {
	const url = new URL(request.url)
	const protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
	return `${protocol}//${url.host}`
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
