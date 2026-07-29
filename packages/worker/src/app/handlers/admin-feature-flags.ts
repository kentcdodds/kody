import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAdminFeatureFlagsData } from '#app/admin-feature-flags-data.ts'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { readNonEmptyTrimmedStringOrNumber } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#app/routes.ts'
import { isFeatureFlagKey } from '#worker/feature-flags/registry.ts'
import {
	clearFeatureFlagUserOverride,
	deleteStaleFeatureFlag,
	setFeatureFlagGlobalState,
	setFeatureFlagUserOverride,
} from '#worker/feature-flags/service.ts'

export function createAdminFeatureFlagsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			const adminFeatureFlags = await loadAdminFeatureFlagsData(env)

			return renderAppPage({
				request,
				env,
				title: 'Admin feature flags',
				loaderData: { adminFeatureFlags },
			})
		},
	} satisfies Action<typeof routes.adminFeatureFlags>
}

export function createAdminFeatureFlagsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithRole(request, env, 'admin')
					const payload = await loadAdminFeatureFlagsData(env)
					return jsonResponse(payload)
				}

				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}

				const actor = await requireUserWithRole(request, env, 'admin')
				const body = await request.json().catch(() => null)
				if (!body || typeof body !== 'object') {
					return jsonResponse(
						{ ok: false, error: 'Invalid request body.' },
						400,
					)
				}

				const action = readNonEmptyTrimmedStringOrNumber(body, 'action')
				if (action === 'set_global') {
					return handleSetGlobalAction({ env, request, url, actor, body })
				}
				if (action === 'set_user_override') {
					return handleSetUserOverrideAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'clear_user_override') {
					return handleClearUserOverrideAction({
						env,
						request,
						url,
						actor,
						body,
					})
				}
				if (action === 'delete_stale') {
					return handleDeleteStaleAction({ env, request, url, actor, body })
				}

				return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminFeatureFlagsApi>
}

async function handleSetGlobalAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const key = readNonEmptyTrimmedStringOrNumber(input.body, 'key')
	if (!key || !isFeatureFlagKey(key)) {
		return jsonResponse(
			{ ok: false, error: 'Unknown or invalid feature flag key.' },
			400,
		)
	}

	const enabled = readBoolean(input.body, 'enabled')
	if (enabled === null) {
		return jsonResponse({ ok: false, error: 'enabled must be a boolean.' }, 400)
	}

	const rolloutPercent = readRolloutPercent(input.body)
	if (rolloutPercent === false) {
		return jsonResponse(
			{
				ok: false,
				error: 'rolloutPercent must be an integer between 0 and 100, or null.',
			},
			400,
		)
	}

	const bodyRecord = input.body as Record<string, unknown>

	try {
		await setFeatureFlagGlobalState(input.env.APP_DB, {
			key,
			enabled,
			rolloutPercent,
			...(Object.hasOwn(bodyRecord, 'note') ? { note: bodyRecord.note } : {}),
			updatedBy: input.actor.userId,
		})
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to update feature flag.',
			},
			400,
		)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'feature_flag_set_global',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: [
			`key=${key}`,
			`enabled=${enabled}`,
			`rollout_percent=${rolloutPercent === null ? 'null' : String(rolloutPercent)}`,
		].join(';'),
	})

	return jsonResponse(await loadAdminFeatureFlagsData(input.env))
}

async function handleSetUserOverrideAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const key = readNonEmptyTrimmedStringOrNumber(input.body, 'key')
	if (!key || !isFeatureFlagKey(key)) {
		return jsonResponse(
			{ ok: false, error: 'Unknown or invalid feature flag key.' },
			400,
		)
	}

	const enabled = readBoolean(input.body, 'enabled')
	if (enabled === null) {
		return jsonResponse({ ok: false, error: 'enabled must be a boolean.' }, 400)
	}

	const resolvedUserId = await resolveOverrideUserId(
		input.env.APP_DB,
		input.body,
	)
	if (resolvedUserId.status === 'invalid') {
		return jsonResponse({ ok: false, error: resolvedUserId.error }, 400)
	}
	if (resolvedUserId.status === 'not_found') {
		return jsonResponse({ ok: false, error: 'User not found.' }, 404)
	}
	const targetUserId = resolvedUserId.userId

	await setFeatureFlagUserOverride(input.env.APP_DB, {
		key,
		userId: targetUserId,
		enabled,
		updatedBy: input.actor.userId,
	})

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'feature_flag_set_user_override',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: [
			`key=${key}`,
			`target_user_id=${targetUserId}`,
			`enabled=${enabled}`,
		].join(';'),
	})

	return jsonResponse(await loadAdminFeatureFlagsData(input.env))
}

async function handleClearUserOverrideAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const key = readNonEmptyTrimmedStringOrNumber(input.body, 'key')
	if (!key || !isFeatureFlagKey(key)) {
		return jsonResponse(
			{ ok: false, error: 'Unknown or invalid feature flag key.' },
			400,
		)
	}

	const userId = readPositiveIntField(input.body, 'userId')
	if (userId === null) {
		return jsonResponse({ ok: false, error: 'userId is required.' }, 400)
	}

	const cleared = await clearFeatureFlagUserOverride(input.env.APP_DB, {
		key,
		userId,
	})
	if (!cleared) {
		return jsonResponse({ ok: false, error: 'User override not found.' }, 404)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'feature_flag_clear_user_override',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: [`key=${key}`, `target_user_id=${userId}`].join(';'),
	})

	return jsonResponse(await loadAdminFeatureFlagsData(input.env))
}

async function handleDeleteStaleAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const key = readNonEmptyTrimmedStringOrNumber(input.body, 'key')
	if (!key) {
		return jsonResponse(
			{ ok: false, error: 'Feature flag key is required.' },
			400,
		)
	}

	try {
		const deleted = await deleteStaleFeatureFlag(input.env.APP_DB, key)
		if (!deleted) {
			return jsonResponse(
				{ ok: false, error: 'Stale feature flag not found.' },
				404,
			)
		}
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to delete feature flag.',
			},
			400,
		)
	}

	const requestIp = getRequestIp(input.request) ?? undefined
	void logAuditEvent({
		category: 'admin',
		action: 'feature_flag_delete_stale',
		result: 'success',
		email: input.actor.email,
		ip: requestIp,
		path: input.url.pathname,
		reason: `key=${key}`,
	})

	return jsonResponse(await loadAdminFeatureFlagsData(input.env))
}

type ResolveOverrideUserIdResult =
	| { status: 'ok'; userId: number }
	| { status: 'invalid'; error: string }
	| { status: 'not_found' }

async function resolveOverrideUserId(
	db: D1Database,
	body: object,
): Promise<ResolveOverrideUserIdResult> {
	const record = body as Record<string, unknown>
	const hasUserId = Object.hasOwn(record, 'userId') && record.userId != null
	const username = readNonEmptyTrimmedStringOrNumber(body, 'username')
	const hasUsername = username !== null

	if (!hasUserId && !hasUsername) {
		return {
			status: 'invalid',
			error: 'Provide either userId or username.',
		}
	}
	if (hasUserId && hasUsername) {
		return {
			status: 'invalid',
			error: 'Provide either userId or username, not both.',
		}
	}

	if (hasUserId) {
		const userId = readPositiveIntField(body, 'userId')
		if (userId === null) {
			return {
				status: 'invalid',
				error: 'userId must be a positive integer.',
			}
		}
		const row = await db
			.prepare(`SELECT id FROM users WHERE id = ?`)
			.bind(userId)
			.first<{ id: number }>()
		if (!row) {
			return { status: 'not_found' }
		}
		return { status: 'ok', userId: row.id }
	}

	if (!username) {
		return {
			status: 'invalid',
			error: 'Provide either userId or username.',
		}
	}
	const row = await db
		.prepare(`SELECT id FROM users WHERE username = ?`)
		.bind(username)
		.first<{ id: number }>()
	if (!row) {
		return { status: 'not_found' }
	}
	return { status: 'ok', userId: row.id }
}

function readRolloutPercent(body: object): number | null | false {
	const value = (body as Record<string, unknown>).rolloutPercent
	if (value === null || value === undefined || value === '') {
		return null
	}
	if (typeof value === 'number') {
		if (!Number.isInteger(value) || value < 0 || value > 100) {
			return false
		}
		return value
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim())
		if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
			return false
		}
		return parsed
	}
	return false
}

function readBoolean(body: object, key: string): boolean | null {
	const value = (body as Record<string, unknown>)[key]
	if (typeof value === 'boolean') return value
	if (value === 'true') return true
	if (value === 'false') return false
	return null
}

function readPositiveIntField(body: object, key: string): number | null {
	const value = (body as Record<string, unknown>)[key]
	if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
		return value
	}
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim())
		if (Number.isInteger(parsed) && parsed > 0) {
			return parsed
		}
	}
	return null
}
