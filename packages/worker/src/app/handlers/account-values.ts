import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import {
	isReservedAccountValueName,
	loadAccountValuesData,
	userScopedStorageContext,
} from '#app/account-values-data.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { requireAuthenticatedPageUser } from '#app/page-auth.ts'
import { readTrimmedStringOrEmpty } from '#app/request-body.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { deleteValue, saveValue } from '#mcp/values/service.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

/**
 * Page handler for `/account/values`, `/account/values/new`, and
 * `/account/values/:valueId`.
 */
export function createAccountValuesHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await requireAuthenticatedPageUser(request, env)
			if (user instanceof Response) {
				return user
			}

			const accountValues = await loadAccountValuesData({
				env,
				user,
				url: request.url,
			})
			return renderAppPage({
				request,
				env,
				title: 'Values',
				loaderData: { accountValues },
			})
		},
	} satisfies Action<
		| typeof routes.accountValues
		| typeof routes.accountValueNew
		| typeof routes.accountValueDetail
	>
}

/**
 * JSON API for `/account/values.json` (GET + POST). Actions: `save`, `delete`.
 */
export function createAccountValuesApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const user = await readAuthenticatedAppUser(request, env)
			if (!user) {
				return jsonResponse({ ok: false, error: 'Unauthorized.' }, 401)
			}

			if (request.method === 'GET') {
				return jsonResponse(
					await loadAccountValuesData({
						env,
						user,
						url: request.url,
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

			const action = readTrimmedStringOrEmpty(body, 'action')
			try {
				if (action === 'save') {
					return await handleSaveAction({ env, user, body })
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
								: 'Unable to update values.',
					},
					400,
				)
			}

			return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
		},
	} satisfies Action<typeof routes.accountValuesApi>
}

const reservedAccountValueWriteError =
	'Value names starting with _integration: or _openapi: are reserved and cannot be saved or deleted from the account UI.'

function assertWritableAccountValueName(name: string) {
	if (!name) {
		throw new Error('Value name is required.')
	}
	if (isReservedAccountValueName(name)) {
		throw new Error(reservedAccountValueWriteError)
	}
}

async function handleSaveAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	const name = readTrimmedStringOrEmpty(input.body, 'name')
	assertWritableAccountValueName(name)
	const value = readTrimmedStringOrEmpty(input.body, 'value')
	const description = readOptionalDescription(input.body)
	const saved = await saveValue({
		env: input.env,
		userId: input.user.mcpUser.userId,
		scope: 'user',
		storageContext: userScopedStorageContext,
		name,
		value,
		description,
		userEmail: input.user.email,
	})
	const payload = await loadAccountValuesData({
		env: input.env,
		user: input.user,
		selectedValueId: saved.name,
	})
	return jsonResponse({
		...payload,
		selectedValueId: saved.name,
	})
}

async function handleDeleteAction(input: {
	env: Env
	user: AuthenticatedUser
	body: object
}) {
	const name = readTrimmedStringOrEmpty(input.body, 'name')
	assertWritableAccountValueName(name)
	const deleted = await deleteValue({
		env: input.env,
		userId: input.user.mcpUser.userId,
		scope: 'user',
		storageContext: userScopedStorageContext,
		name,
	})
	if (!deleted) {
		return jsonResponse({ ok: false, error: 'Value not found.' }, 404)
	}
	return jsonResponse(
		await loadAccountValuesData({
			env: input.env,
			user: input.user,
			selectedValueId: null,
		}),
	)
}

function readOptionalDescription(body: object) {
	const value = (body as Record<string, unknown>).description
	if (typeof value !== 'string') return null
	return value.trim()
}
