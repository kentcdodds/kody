import { jsonResponse } from '#worker/json-response.ts'
import { type Action } from 'remix/router'
import { loadAdminBannersData } from '#app/admin-banners-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { readNonEmptyTrimmedStringOrNumber } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import {
	isSiteBannerId,
	parseSiteBannerInput,
} from '#universal/site-banners.ts'
import {
	deleteSiteBanner,
	saveSiteBanner,
} from '#worker/site-banners/service.ts'

export function createAdminBannersHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			const adminBanners = await loadAdminBannersData(env)

			return renderAppPage({
				request,
				env,
				title: 'Admin banners',
				loaderData: { adminBanners },
			})
		},
	} satisfies Action<typeof routes.adminBanners>
}

export function createAdminBannersApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithRole(request, env, 'admin')
					return jsonResponse(await loadAdminBannersData(env))
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
				if (action === 'save') {
					return handleSaveAction({ env, request, url, actor, body })
				}
				if (action === 'delete') {
					return handleDeleteAction({ env, request, url, actor, body })
				}

				return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminBannersApi>
}

async function handleSaveAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const parsed = parseSiteBannerInput(input.body as Record<string, unknown>)
	if (!parsed.ok) {
		return jsonResponse({ ok: false, error: parsed.error }, 400)
	}

	try {
		const banner = await saveSiteBanner(input.env.APP_DB, {
			banner: parsed.value,
			actorUserId: input.actor.userId,
		})
		void logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'admin',
			action: 'site_banner_save',
			result: 'success',
			email: input.actor.email,
			ip: getRequestIp(input.request) ?? undefined,
			path: input.url.pathname,
			reason: [
				`id=${banner.id}`,
				`enabled=${banner.enabled}`,
				`priority=${String(banner.priority)}`,
				`look=${banner.look}`,
			].join(';'),
		})
		return jsonResponse({
			...(await loadAdminBannersData(input.env)),
			savedBannerId: banner.id,
		})
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error ? error.message : 'Unable to save banner.',
			},
			400,
		)
	}
}

async function handleDeleteAction(input: {
	env: Env
	request: Request
	url: URL
	actor: Awaited<ReturnType<typeof requireUserWithRole>>
	body: object
}) {
	const id = readNonEmptyTrimmedStringOrNumber(input.body, 'id')
	if (!id || !isSiteBannerId(id)) {
		return jsonResponse({ ok: false, error: 'id must be a UUID.' }, 400)
	}

	const deleted = await deleteSiteBanner(input.env.APP_DB, id)
	if (!deleted) {
		return jsonResponse({ ok: false, error: 'Banner not found.' }, 404)
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'admin',
		action: 'site_banner_delete',
		result: 'success',
		email: input.actor.email,
		ip: getRequestIp(input.request) ?? undefined,
		path: input.url.pathname,
		reason: `id=${id}`,
	})

	return jsonResponse(await loadAdminBannersData(input.env))
}
