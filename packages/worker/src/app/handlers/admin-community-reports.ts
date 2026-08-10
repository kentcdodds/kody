import { jsonResponse } from '#worker/json-response.ts'
import { z } from 'zod'
import { type Action } from 'remix/router'
import { loadAdminCommunityReportsData } from '#app/admin-community-reports-data.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { type routes } from '#universal/routes.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	banCommunityUser,
	resolveCommunityReport,
} from '#worker/community/service.ts'
import { getCommunityReportById } from '#worker/community/repo.ts'

const adminCommunityReportPostSchema = z.object({
	intent: z.enum([
		'dismiss',
		'delist',
		'delete',
		'ban_reporter',
		'ban_reportee',
	]),
	reportId: z.string().min(1),
	note: z.string().optional(),
})

export function createAdminCommunityReportsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			const adminCommunityReports = await loadAdminCommunityReportsData(
				env,
				request.url,
			)

			return renderAppPage({
				request,
				env,
				title: 'Community reports',
				loaderData: { adminCommunityReports },
			})
		},
	} satisfies Action<typeof routes.adminCommunityReports>
}

export function createAdminCommunityReportsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				if (request.method === 'GET') {
					await requireUserWithRole(request, env, 'admin')
					const payload = await loadAdminCommunityReportsData(env, request.url)
					return jsonResponse(payload)
				}

				if (request.method !== 'POST') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}

				const actor = await requireUserWithRole(request, env, 'admin')
				const body = await request.json().catch(() => null)
				const parsed = adminCommunityReportPostSchema.safeParse(body)
				if (!parsed.success) {
					return jsonResponse(
						{
							ok: false,
							error: parsed.error.issues[0]?.message ?? 'Invalid request body.',
						},
						400,
					)
				}

				const report = await getCommunityReportById(
					env.APP_DB,
					parsed.data.reportId,
				)
				if (!report) {
					return jsonResponse({ ok: false, error: 'Report not found.' }, 404)
				}

				const note = parsed.data.note?.trim() || undefined
				const adminUserId = actor.mcpUser.userId

				switch (parsed.data.intent) {
					case 'dismiss':
					case 'delist':
					case 'delete': {
						try {
							await resolveCommunityReport({
								env,
								adminUserId,
								reportId: parsed.data.reportId,
								action: parsed.data.intent,
								resolutionNote: note,
							})
						} catch (error) {
							if (error instanceof CommunityActionError) {
								return jsonResponse({ ok: false, error: error.message }, 400)
							}
							console.error('Community report resolution failed:', error)
							return jsonResponse(
								{ ok: false, error: 'Unable to resolve report.' },
								500,
							)
						}
						break
					}
					case 'ban_reporter': {
						try {
							await banCommunityUser({
								env,
								adminUserId,
								userId: report.reporterUserId,
								reason:
									note ??
									`Banned via community report moderation (${report.id}).`,
							})
						} catch (error) {
							if (error instanceof CommunityActionError) {
								return jsonResponse({ ok: false, error: error.message }, 400)
							}
							console.error('Community ban failed:', error)
							return jsonResponse(
								{ ok: false, error: 'Unable to ban user.' },
								500,
							)
						}
						break
					}
					case 'ban_reportee': {
						try {
							await banCommunityUser({
								env,
								adminUserId,
								userId: report.listingOwnerUserId,
								reason:
									note ??
									`Banned via community report moderation (${report.id}).`,
							})
						} catch (error) {
							if (error instanceof CommunityActionError) {
								return jsonResponse({ ok: false, error: error.message }, 400)
							}
							console.error('Community ban failed:', error)
							return jsonResponse(
								{ ok: false, error: 'Unable to ban user.' },
								500,
							)
						}
						break
					}
					default: {
						const unreachable: never = parsed.data.intent
						throw new Error(`Unsupported intent: ${unreachable}`)
					}
				}

				return jsonResponse({ ok: true })
			} catch (error) {
				if (error instanceof Response) {
					return error
				}
				throw error
			}
		},
	} satisfies Action<typeof routes.adminCommunityReportsApi>
}
