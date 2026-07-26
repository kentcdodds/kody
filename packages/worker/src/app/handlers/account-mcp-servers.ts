import { jsonResponse } from '#worker/json-response.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type Action } from 'remix/router'
import { loadAccountMcpServersData } from '#app/account-mcp-servers-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import { getAppBaseUrl } from '#app/app-base-url.ts'
import { createMcpClientHubClient } from '#worker/mcp-client/hub-client.ts'
import {
	addMcpServer,
	deleteMcpServer,
	getMcpServerSettingById,
	setMcpServerEnabled,
} from '#worker/mcp-client/settings-service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

export function createAccountMcpServersHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountMcpServers = await loadAccountMcpServersData({ env, user })
			return renderAppPage({
				request,
				env,
				title: 'MCP servers',
				loaderData: { accountMcpServers },
			})
		},
	} satisfies Action<
		| typeof routes.accountMcpServers
		| typeof routes.accountMcpServerNew
		| typeof routes.accountMcpServerDetail
	>
}

export function createAccountMcpServersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(await loadAccountMcpServersData({ env, user }))
			}

			if (request.method !== 'POST') {
				return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
			}

			const body = await request.json().catch(() => null)
			if (!body || typeof body !== 'object') {
				return jsonResponse({ ok: false, error: 'Invalid request body.' }, 400)
			}

			const action = readTrimmedStringOrEmpty(body, 'action')
			try {
				if (action === 'add') {
					return await handleAddAction({ env, user, body, request })
				}
				if (action === 'reconnect') {
					return await handleConnectionAction({
						env,
						user,
						body,
						kind: 'reconnect',
					})
				}
				if (action === 'refresh') {
					return await handleConnectionAction({
						env,
						user,
						body,
						kind: 'refresh',
					})
				}
				if (action === 'set-enabled') {
					return await handleSetEnabledAction({ env, user, body })
				}
				if (action === 'delete') {
					return await handleDeleteAction({ env, user, body })
				}
			} catch (error) {
				return jsonResponse(
					{
						ok: false,
						error:
							error instanceof Error
								? error.message
								: 'Unable to update MCP server settings.',
					},
					400,
				)
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<typeof routes.accountMcpServersApi>
}

/**
 * Completes the OAuth authorization redirect from a remote MCP server. The
 * browser session cookie identifies the user, whose per-user hub DO holds the
 * pending OAuth state matching the `state` query parameter.
 */
export function createAccountMcpServersOauthCallbackHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const hub = createMcpClientHubClient({
				env,
				userId: user.mcpUser.userId,
			})
			let authSuccess = false
			let authError: string | null = null
			let serverName: string | null = null
			let serverId: string | null = null
			try {
				const outcome = await hub.handleOAuthCallback({ url: request.url })
				authSuccess = outcome.authSuccess
				authError = outcome.authError
				serverName = outcome.serverName
				serverId = outcome.serverId
			} catch (error) {
				authError = getErrorMessage(error)
			}

			const target = serverId
				? new URL(
						`/account/mcp-servers/${encodeURIComponent(serverId)}`,
						request.url,
					)
				: new URL('/account/mcp-servers', request.url)
			if (authSuccess) {
				target.searchParams.set('auth', 'success')
				if (serverName) {
					target.searchParams.set('server', serverName)
				}
			} else {
				target.searchParams.set('auth', 'error')
				target.searchParams.set('reason', authError ?? 'Authorization failed.')
			}
			return Response.redirect(target.toString(), 303)
		},
	} satisfies Action<typeof routes.accountMcpServersOauthCallback>
}

async function handleAddAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	request: Request
}) {
	const { setting } = await addMcpServer({
		env: input.env,
		userId: input.user.mcpUser.userId,
		name: readTrimmedStringOrEmpty(input.body, 'name'),
		url: readTrimmedStringOrEmpty(input.body, 'url'),
		baseUrl: getAppBaseUrl({
			env: input.env,
			requestUrl: input.request.url,
		}),
	})
	const payload = await loadAccountMcpServersData({
		env: input.env,
		user: input.user,
	})
	return jsonResponse({
		...payload,
		selectedServerId: setting.id,
	})
}

async function handleConnectionAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
	kind: 'reconnect' | 'refresh'
}) {
	const setting = await requireSetting(input)
	const hub = createMcpClientHubClient({
		env: input.env,
		userId: input.user.mcpUser.userId,
	})
	if (input.kind === 'reconnect') {
		await hub.reconnectServer({ serverId: setting.id })
	} else {
		await hub.refreshServer({ serverId: setting.id })
	}
	const payload = await loadAccountMcpServersData({
		env: input.env,
		user: input.user,
	})
	return jsonResponse({
		...payload,
		selectedServerId: setting.id,
	})
}

async function handleSetEnabledAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	const setting = await requireSetting(input)
	const updated = await setMcpServerEnabled({
		env: input.env,
		userId: input.user.mcpUser.userId,
		id: setting.id,
		enabled: readBoolean(input.body, 'enabled', true),
	})
	const payload = await loadAccountMcpServersData({
		env: input.env,
		user: input.user,
	})
	return jsonResponse({
		...payload,
		selectedServerId: updated.id,
	})
}

async function handleDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	const setting = await requireSetting(input)
	const deleted = await deleteMcpServer({
		env: input.env,
		userId: input.user.mcpUser.userId,
		id: setting.id,
	})
	if (!deleted) {
		return jsonResponse({ ok: false, error: 'MCP server not found.' }, 404)
	}
	return jsonResponse(
		await loadAccountMcpServersData({
			env: input.env,
			user: input.user,
		}),
	)
}

async function requireSetting(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	const id = readTrimmedStringOrEmpty(input.body, 'id')
	if (!id) {
		throw new Error('MCP server id is required.')
	}
	const setting = await getMcpServerSettingById({
		env: input.env,
		userId: input.user.mcpUser.userId,
		id,
	})
	if (!setting) {
		throw new Error('MCP server not found.')
	}
	return setting
}

function readBoolean(body: object, key: string, defaultValue: boolean) {
	const value = (body as Record<string, unknown>)[key]
	return typeof value === 'boolean' ? value : defaultValue
}
