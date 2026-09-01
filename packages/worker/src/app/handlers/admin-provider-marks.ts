import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import { type Action } from 'remix/router'
import { loadAdminProviderMarksData } from '#app/admin-provider-marks-data.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { readNonEmptyTrimmedString as readString } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import {
	deletePlatformProviderMark,
	deletePlatformProviderMarkLogoAsset,
	getPlatformProviderMarkBySlug,
	PlatformProviderMarkValidationError,
	setPlatformProviderMarkLogo,
	upsertPlatformProviderMark,
} from '#worker/integrations/provider-marks.ts'
import { jsonResponse } from '#worker/json-response.ts'

export function createAdminProviderMarksHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}
			return renderAppPage({
				request,
				env,
				title: 'Admin provider marks',
				loaderData: {
					adminProviderMarks: await loadAdminProviderMarksData(env),
				},
			})
		},
	} satisfies Action<typeof routes.adminProviderMarks>
}

export function createAdminProviderMarksApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithRole(request, env, 'admin')
					return jsonResponse(await loadAdminProviderMarksData(env))
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

				const action = readString(body, 'action')
				if (action === 'save') {
					return await handleSaveAction({ env, request, url, actor, body })
				}
				if (action === 'delete') {
					return await handleDeleteAction({ env, request, url, actor, body })
				}
				return jsonResponse({ ok: false, error: 'Invalid action.' }, 400)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminProviderMarksApi>
}

type AdminActor = Awaited<ReturnType<typeof requireUserWithRole>>

async function handleSaveAction(input: {
	env: Env
	request: Request
	url: URL
	actor: AdminActor
	body: object
}) {
	const record = input.body as Record<string, unknown>
	const slug = readString(input.body, 'slug')
	if (!slug) {
		return jsonResponse({ ok: false, error: 'Slug is required.' }, 400)
	}
	const label = readString(input.body, 'label')
	const aliases = Array.isArray(record.aliases)
		? record.aliases.filter(
				(value): value is string => typeof value === 'string',
			)
		: undefined
	let logoBytes: Uint8Array | null | undefined
	let logoEnv: Pick<Env, 'COMMUNITY_ASSETS' | 'IMAGES'> | undefined
	if (record.logoBase64 !== undefined) {
		const assets = input.env.COMMUNITY_ASSETS
		const images = input.env.IMAGES
		if (!assets || !images) {
			return jsonResponse(
				{ ok: false, error: 'Logo storage is not configured.' },
				503,
			)
		}
		logoEnv = { COMMUNITY_ASSETS: assets, IMAGES: images }
		const logoBase64 = record.logoBase64
		if (typeof logoBase64 === 'string' && logoBase64.trim()) {
			try {
				logoBytes = base64ToBytes(logoBase64.trim())
			} catch {
				return jsonResponse(
					{ ok: false, error: 'Logo file is not valid base64.' },
					400,
				)
			}
		} else {
			logoBytes = null
		}
	}
	try {
		let mark = await upsertPlatformProviderMark({
			db: input.env.APP_DB,
			slug,
			...(label ? { label } : {}),
			...(aliases ? { aliases } : {}),
		})
		if (logoBytes !== undefined && logoEnv) {
			mark = await setPlatformProviderMarkLogo({
				db: input.env.APP_DB,
				env: logoEnv,
				slug: mark.slug,
				sourceBytes: logoBytes,
			})
		}
		void logAuditEvent({
			category: 'admin',
			action: 'platform_provider_mark_admin_save',
			result: 'success',
			email: input.actor.email,
			ip: getRequestIp(input.request) ?? undefined,
			path: input.url.pathname,
			reason: `platform_provider_mark=${mark.slug}`,
		})
		return jsonResponse(await loadAdminProviderMarksData(input.env))
	} catch (error) {
		if (error instanceof PlatformProviderMarkValidationError) {
			return jsonResponse({ ok: false, error: error.message }, 400)
		}
		throw error
	}
}

async function handleDeleteAction(input: {
	env: Env
	request: Request
	url: URL
	actor: AdminActor
	body: object
}) {
	const slug = readString(input.body, 'slug')
	if (!slug) {
		return jsonResponse({ ok: false, error: 'Slug is required.' }, 400)
	}
	const existing = await getPlatformProviderMarkBySlug({
		db: input.env.APP_DB,
		slug,
	})
	const deleted = await deletePlatformProviderMark({
		db: input.env.APP_DB,
		slug,
	})
	if (deleted && input.env.COMMUNITY_ASSETS) {
		await deletePlatformProviderMarkLogoAsset({
			env: { COMMUNITY_ASSETS: input.env.COMMUNITY_ASSETS },
			logoKey: existing?.logoKey ?? null,
		})
	}
	void logAuditEvent({
		category: 'admin',
		action: 'platform_provider_mark_admin_delete',
		result: 'success',
		email: input.actor.email,
		ip: getRequestIp(input.request) ?? undefined,
		path: input.url.pathname,
		reason: `platform_provider_mark=${slug}`,
	})
	return jsonResponse(await loadAdminProviderMarksData(input.env))
}
