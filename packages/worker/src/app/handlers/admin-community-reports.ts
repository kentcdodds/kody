import { z } from 'zod'
import { type Action } from 'remix/router'
import { readAuthSessionResult } from '#app/auth-session.ts'
import { redirectToLogin } from '#app/auth-redirect.ts'
import { Layout } from '#app/layout.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import { render } from '#app/render.ts'
import { type routes } from '#app/routes.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	banCommunityUser,
	listCommunityReports,
	resolveCommunityReport,
} from '#worker/community/service.ts'
import { getCommunityReportById } from '#worker/community/repo.ts'
import { type CommunityReportRecord } from '#worker/community/types.ts'

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

type AdminCommunityReportListItem = {
	id: string
	listingId: string
	listingName: string
	listingOwnerUserId: string
	reporterUserId: string
	reason: string
	status: CommunityReportRecord['status']
	createdAt: string
	resolvedAt: string | null
	resolutionNote: string | null
}

type AdminCommunityReportsPayload = {
	ok: true
	reports: Array<AdminCommunityReportListItem>
	statusFilter: string
}

export function createAdminCommunityReportsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			try {
				await requireUserWithRole(request, env, 'admin')
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}

			const { session, setCookie } = await readAuthSessionResult(request)
			if (!session) {
				return redirectToLogin(request)
			}

			const response = render(Layout({ title: 'Community reports' }))
			if (setCookie) {
				response.headers.set('Set-Cookie', setCookie)
			}
			return response
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
					const url = new URL(request.url)
					const statusFilter = url.searchParams.get('status') ?? 'open'
					const reports = await loadAdminCommunityReports(env, statusFilter)
					return jsonResponse({
						ok: true,
						reports,
						statusFilter,
					} satisfies AdminCommunityReportsPayload)
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

async function loadAdminCommunityReports(
	env: Env,
	statusFilter: string,
): Promise<Array<AdminCommunityReportListItem>> {
	if (statusFilter === 'all') {
		const reports = await listCommunityReports({ env })
		return reports.map(toAdminCommunityReportListItem)
	}

	const status = readReportStatusFilter(statusFilter)
	const reports = await listCommunityReports({
		env,
		status,
	})
	return reports.map(toAdminCommunityReportListItem)
}

function readReportStatusFilter(
	statusFilter: string,
): CommunityReportRecord['status'] {
	switch (statusFilter) {
		case 'open':
		case 'resolved':
		case 'dismissed':
			return statusFilter
		default:
			return 'open'
	}
}

function toAdminCommunityReportListItem(
	report: CommunityReportRecord,
): AdminCommunityReportListItem {
	return {
		id: report.id,
		listingId: report.listingId,
		listingName: report.listingName,
		listingOwnerUserId: report.listingOwnerUserId,
		reporterUserId: report.reporterUserId,
		reason: report.reason,
		status: report.status,
		createdAt: report.createdAt,
		resolvedAt: report.resolvedAt,
		resolutionNote: report.resolutionNote,
	}
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'application/json; charset=utf-8',
		},
	})
}
