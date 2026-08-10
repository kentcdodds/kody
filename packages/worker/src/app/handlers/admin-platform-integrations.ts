import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import { type Action } from 'remix/router'
import { loadAdminPlatformIntegrationsData } from '#app/admin-platform-integrations-data.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { readNonEmptyTrimmedString as readString } from '#app/request-body.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { type routes } from '#universal/routes.ts'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import {
	deletePlatformOauthAppLogoAsset,
	setPlatformOauthAppLogo,
} from '#worker/integrations/platform-app-logo.ts'
import {
	deletePlatformOauthApp,
	getPlatformOauthAppBySlug,
	upsertPlatformOauthApp,
} from '#worker/integrations/platform-apps.ts'
import { jsonResponse } from '#worker/json-response.ts'

export function createAdminPlatformIntegrationsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}
			const adminPlatformIntegrations =
				await loadAdminPlatformIntegrationsData(env)
			return renderAppPage({
				request,
				env,
				title: 'Admin platform integrations',
				loaderData: { adminPlatformIntegrations },
			})
		},
	} satisfies Action<typeof routes.adminPlatformIntegrations>
}

export function createAdminPlatformIntegrationsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithRole(request, env, 'admin')
					return jsonResponse(await loadAdminPlatformIntegrationsData(env))
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
	} satisfies Action<typeof routes.adminPlatformIntegrationsApi>
}

type AdminActor = Awaited<ReturnType<typeof requireUserWithRole>>

/**
 * Create/update a platform app. Field semantics mirror the
 * `admin_platform_oauth_app_save` capability: `clientSecret` and
 * `logoBase64` are write-only (omit retains, null/empty clears the logo;
 * an empty clientSecret clears only for pkce flow), and omitted optional
 * fields retain stored values through the upsert's retain-on-omit contract.
 */
async function handleSaveAction(input: {
	env: Env
	request: Request
	url: URL
	actor: AdminActor
	body: object
}) {
	const record = input.body as Record<string, unknown>
	const slug = readString(input.body, 'slug')
	const clientId = readString(input.body, 'clientId')
	const tokenUrl = readString(input.body, 'tokenUrl')
	const authorizeUrl = readString(input.body, 'authorizeUrl')
	const flow = readString(input.body, 'flow')
	if (!slug) {
		return jsonResponse({ ok: false, error: 'Slug is required.' }, 400)
	}
	if (!clientId || !tokenUrl || !authorizeUrl) {
		return jsonResponse(
			{
				ok: false,
				error: 'Client id, token URL, and authorize URL are required.',
			},
			400,
		)
	}
	if (flow !== 'pkce' && flow !== 'confidential') {
		return jsonResponse({ ok: false, error: 'Invalid OAuth flow.' }, 400)
	}

	try {
		const app = await upsertPlatformOauthApp({
			db: input.env.APP_DB,
			env: input.env,
			app: {
				slug,
				provider: readOptionalString(record, 'provider'),
				label: readOptionalString(record, 'label'),
				description: readOptionalString(record, 'description'),
				clientId,
				clientSecret: readWriteOnlyString(record, 'clientSecret'),
				tokenUrl,
				authorizeUrl,
				apiBaseUrl: readOptionalString(record, 'apiBaseUrl'),
				flow,
				usePkce: readOptionalBoolean(record, 'usePkce'),
				tokenExchangeStyle: readTokenExchangeStyle(record),
				scopeSeparator: readOptionalString(record, 'scopeSeparator'),
				extraAuthorizeParams: readOptionalRecord(
					record,
					'extraAuthorizeParams',
				),
				allowedScopes: readOptionalStringArray(record, 'allowedScopes'),
				defaultScopes: readOptionalStringArray(record, 'defaultScopes'),
				requiredHosts: readOptionalStringArray(record, 'requiredHosts'),
				enabled: readOptionalBoolean(record, 'enabled') ?? undefined,
			},
		})
		const logoBase64 = record.logoBase64
		if (logoBase64 !== undefined) {
			await setPlatformOauthAppLogo({
				db: input.env.APP_DB,
				env: input.env,
				slug: app.slug,
				sourceBytes:
					typeof logoBase64 === 'string' && logoBase64.trim()
						? base64ToBytes(logoBase64.trim())
						: null,
			})
		}
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to save platform integration.',
			},
			400,
		)
	}

	void logAuditEvent({
		category: 'admin',
		action: 'platform_oauth_app_admin_save',
		result: 'success',
		email: input.actor.email,
		ip: getRequestIp(input.request) ?? undefined,
		path: input.url.pathname,
		reason: `platform_oauth_app=${slug}`,
	})
	return jsonResponse(await loadAdminPlatformIntegrationsData(input.env))
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
	try {
		const existing = await getPlatformOauthAppBySlug({
			db: input.env.APP_DB,
			slug,
			includeDisabled: true,
		})
		const deleted = await deletePlatformOauthApp({
			db: input.env.APP_DB,
			slug,
		})
		if (!deleted) {
			return jsonResponse(
				{ ok: false, error: 'Platform integration not found.' },
				404,
			)
		}
		await deletePlatformOauthAppLogoAsset({
			env: input.env,
			logoKey: existing?.logoKey ?? null,
		})
	} catch (error) {
		return jsonResponse(
			{
				ok: false,
				error:
					error instanceof Error
						? error.message
						: 'Unable to delete platform integration.',
			},
			400,
		)
	}

	void logAuditEvent({
		category: 'admin',
		action: 'platform_oauth_app_admin_delete',
		result: 'success',
		email: input.actor.email,
		ip: getRequestIp(input.request) ?? undefined,
		path: input.url.pathname,
		reason: `platform_oauth_app=${slug}`,
	})
	return jsonResponse(await loadAdminPlatformIntegrationsData(input.env))
}

function readOptionalString(record: Record<string, unknown>, key: string) {
	if (!(key in record)) return undefined
	const value = record[key]
	if (value === null) return null
	return typeof value === 'string' ? value.trim() || null : null
}

/** Write-only credential: omitted = retain, empty/null = clear. */
function readWriteOnlyString(record: Record<string, unknown>, key: string) {
	if (!(key in record)) return undefined
	const value = record[key]
	if (value === null) return null
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOptionalBoolean(record: Record<string, unknown>, key: string) {
	if (!(key in record)) return undefined
	const value = record[key]
	return typeof value === 'boolean' ? value : null
}

function readOptionalStringArray(record: Record<string, unknown>, key: string) {
	if (!(key in record)) return undefined
	const value = record[key]
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string')
}

function readOptionalRecord(record: Record<string, unknown>, key: string) {
	if (!(key in record)) return undefined
	const value = record[key]
	if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string',
		),
	)
}

function readTokenExchangeStyle(record: Record<string, unknown>) {
	if (!('tokenExchangeStyle' in record)) return undefined
	const value = record.tokenExchangeStyle
	return value === 'form' || value === 'basic-json' || value === 'basic-form'
		? value
		: null
}
