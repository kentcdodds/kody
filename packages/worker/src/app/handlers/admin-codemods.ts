import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { type Action } from 'remix/router'
import {
	type AdminCodemodRunItemsLoaderData,
	type AdminCodemodsLoaderData,
} from '#app/loader-data.ts'
import { requirePageUserWithRole } from '#app/page-auth.ts'
import { requireUserWithRole } from '#app/permissions-server.ts'
import {
	readNonEmptyTrimmedString,
	readNonEmptyTrimmedStringOrNumber,
} from '#app/request-body.ts'
import { type routes } from '#app/routes.ts'
import { renderAppPage } from '#app/ssr-render.tsx'
import { getRequestIp, logAuditEvent } from '#worker/audit-log.ts'
import { jsonResponse } from '#worker/json-response.ts'
import {
	runPackageCodemodStep,
	type PackageCodemodRunMode,
	type PackageCodemodRunScope,
} from '#worker/package-codemods/engine.ts'
import {
	getPackageCodemodRunById,
	listPackageCodemodRunItems,
	listPackageCodemodRuns,
	markAbandonedPackageCodemodRuns,
	updatePackageCodemodRunStatus,
} from '#worker/package-codemods/ledger.ts'
import {
	getPackageCodemodById,
	listPackageCodemods,
} from '#worker/package-codemods/registry.ts'
import { readPositiveInt } from '#worker/query-params.ts'

const recentRunsLimit = 50
const defaultRunItemsLimit = 50
const maxRunItemsLimit = 200
// Every engine step re-asserts `running` (heartbeat), and a step is a single
// Workers request, so a `running` run untouched for this long has no caller
// paging it anymore.
const staleRunningRunThresholdMs = 60 * 60 * 1000

const packageCodemodRunModes = [
	'scan',
	'dry-run',
	'apply',
	'revert',
] as const satisfies ReadonlyArray<PackageCodemodRunMode>

export async function loadAdminCodemodsData(
	env: Env,
): Promise<AdminCodemodsLoaderData> {
	// Lazy reconciliation instead of a scheduled sweeper: viewing the admin
	// history is the moment stale `running` rows would mislead, so mark them
	// `abandoned` right before listing.
	await markAbandonedPackageCodemodRuns(env.APP_DB, {
		updatedBefore: new Date(
			Date.now() - staleRunningRunThresholdMs,
		).toISOString(),
	})
	const [codemods, runs] = await Promise.all([
		Promise.resolve(listPackageCodemods()),
		listPackageCodemodRuns(env.APP_DB, { limit: recentRunsLimit }),
	])
	return {
		ok: true,
		codemods,
		runs,
	}
}

export function createAdminCodemodsHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request }) {
			const admin = await requirePageUserWithRole(request, env, 'admin')
			if (admin instanceof Response) {
				return admin
			}

			const adminCodemods = await loadAdminCodemodsData(env)

			return renderAppPage({
				request,
				env,
				title: 'Admin codemods',
				loaderData: { adminCodemods },
			})
		},
	} satisfies Action<typeof routes.adminCodemods>
}

export function createAdminCodemodsApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
				if (request.method !== 'GET') {
					return jsonResponse({ ok: false, error: 'Method not allowed.' }, 405)
				}
				await requireUserWithRole(request, env, 'admin')

				const runId = url.searchParams.get('runId')?.trim() || null
				if (runId) {
					const limit = readPositiveInt(
						url.searchParams.get('limit'),
						defaultRunItemsLimit,
						maxRunItemsLimit,
					)
					const afterId = url.searchParams.get('afterId')?.trim() || null
					const [run, items] = await Promise.all([
						getPackageCodemodRunById(env.APP_DB, runId),
						listPackageCodemodRunItems(env.APP_DB, {
							runId,
							afterId,
							limit,
						}),
					])
					const nextAfterId =
						items.length === limit
							? (items[items.length - 1]?.id ?? null)
							: null
					const payload: AdminCodemodRunItemsLoaderData = {
						ok: true,
						run,
						items,
						nextAfterId,
					}
					return jsonResponse(payload)
				}

				const payload = await loadAdminCodemodsData(env)
				return jsonResponse(payload)
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminCodemodsApi>
}

export function createAdminCodemodsRunApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
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

				const parsed = parseRunBody(body)
				if (!parsed.ok) {
					return jsonResponse({ ok: false, error: parsed.error }, 400)
				}

				try {
					const result = await runPackageCodemodStep({
						env,
						baseUrl: url.origin,
						initiatedByUserId: actor.mcpUser.userId,
						codemodId: parsed.codemodId,
						mode: parsed.mode,
						scope: parsed.scope,
						...(parsed.filters ? { filters: parsed.filters } : {}),
						...(parsed.runId ? { runId: parsed.runId } : {}),
						...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
						...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
						...(parsed.revertOfRunId
							? { revertOfRunId: parsed.revertOfRunId }
							: {}),
					})

					const requestIp = getRequestIp(request) ?? undefined
					void logAuditEvent({
						category: 'admin',
						action: 'package_codemod_run_step',
						result: 'success',
						email: actor.email,
						ip: requestIp,
						path: url.pathname,
						reason: [
							`codemod_id=${parsed.codemodId}`,
							`mode=${parsed.mode}`,
							`scope=${formatScopeForAudit(parsed.scope)}`,
							`run_id=${result.runId}`,
							`next_cursor=${result.nextCursor ?? 'null'}`,
							`item_count=${result.items.length}`,
						].join(';'),
					})

					return jsonResponse({ ok: true, ...result })
				} catch (error) {
					return jsonResponse({ ok: false, error: getErrorMessage(error) }, 400)
				}
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminCodemodsRunApi>
}

export function createAdminCodemodsRunStopApiHandler(env: Env) {
	return {
		middleware: [],
		async handler({ request, url }) {
			try {
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
				const runId = readNonEmptyTrimmedString(body, 'runId')
				if (!runId) {
					return jsonResponse({ ok: false, error: 'runId is required.' }, 400)
				}
				const run = await getPackageCodemodRunById(env.APP_DB, runId)
				if (!run) {
					return jsonResponse(
						{
							ok: false,
							error: `Package codemod run "${runId}" was not found.`,
						},
						404,
					)
				}
				if (run.status !== 'running') {
					return jsonResponse({ ok: true, runId, status: run.status })
				}
				// Conditional on the row still being `running` so a concurrent
				// engine step that just completed the run is not overwritten.
				const changed = await updatePackageCodemodRunStatus(env.APP_DB, {
					id: runId,
					status: 'abandoned',
					expectedStatus: 'running',
				})
				if (changed === 0) {
					const current = await getPackageCodemodRunById(env.APP_DB, runId)
					return jsonResponse({
						ok: true,
						runId,
						status: current?.status ?? run.status,
					})
				}
				const requestIp = getRequestIp(request) ?? undefined
				void logAuditEvent({
					category: 'admin',
					action: 'package_codemod_run_stop',
					result: 'success',
					email: actor.email,
					ip: requestIp,
					path: url.pathname,
					reason: `run_id=${runId};codemod_id=${run.codemodId};mode=${run.mode}`,
				})
				return jsonResponse({ ok: true, runId, status: 'abandoned' })
			} catch (error) {
				if (error instanceof Response) return error
				throw error
			}
		},
	} satisfies Action<typeof routes.adminCodemodsRunStopApi>
}

type ParseRunBodyResult =
	| {
			ok: true
			codemodId: string
			mode: PackageCodemodRunMode
			scope: PackageCodemodRunScope
			filters?: { userIds?: Array<string>; packageIds?: Array<string> }
			runId?: string
			cursor?: string | null
			limit?: number
			revertOfRunId?: string
	  }
	| { ok: false; error: string }

function parseRunBody(body: object): ParseRunBodyResult {
	const codemodId = readNonEmptyTrimmedString(body, 'codemodId')
	if (!codemodId) {
		return { ok: false, error: 'codemodId is required.' }
	}
	if (!getPackageCodemodById(codemodId)) {
		return { ok: false, error: `Unknown package codemod "${codemodId}".` }
	}

	const modeRaw = readNonEmptyTrimmedString(body, 'mode')
	if (!modeRaw) {
		return { ok: false, error: 'mode is required.' }
	}
	const mode = parsePackageCodemodRunMode(modeRaw)
	if (!mode) {
		return {
			ok: false,
			error: 'mode must be one of scan, dry-run, apply, or revert.',
		}
	}

	const scope = parseScope(body, mode)
	if (!scope.ok) {
		return scope
	}

	const filters = parseFilters(body)
	if (!filters.ok) {
		return filters
	}

	const runId = readNonEmptyTrimmedString(body, 'runId') ?? undefined
	const revertOfRunId =
		readNonEmptyTrimmedString(body, 'revertOfRunId') ?? undefined

	const record = body as Record<string, unknown>
	let cursor: string | null | undefined
	if (Object.hasOwn(record, 'cursor')) {
		const cursorValue = record.cursor
		if (cursorValue === null) {
			cursor = null
		} else if (typeof cursorValue === 'string') {
			cursor = cursorValue.trim() || null
		} else {
			return { ok: false, error: 'cursor must be a string or null.' }
		}
	}

	let limit: number | undefined
	if (
		Object.hasOwn(record, 'limit') &&
		record.limit != null &&
		record.limit !== ''
	) {
		const limitRaw = readNonEmptyTrimmedStringOrNumber(body, 'limit')
		if (!limitRaw) {
			return { ok: false, error: 'limit must be a positive integer.' }
		}
		const parsedLimit = Number(limitRaw)
		if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
			return { ok: false, error: 'limit must be a positive integer.' }
		}
		limit = parsedLimit
	}

	if (mode === 'revert' && !revertOfRunId) {
		return { ok: false, error: 'revert mode requires revertOfRunId.' }
	}

	return {
		ok: true,
		codemodId,
		mode,
		scope: scope.scope,
		...(filters.filters ? { filters: filters.filters } : {}),
		...(runId ? { runId } : {}),
		...(cursor !== undefined ? { cursor } : {}),
		...(limit !== undefined ? { limit } : {}),
		...(revertOfRunId ? { revertOfRunId } : {}),
	}
}

function parsePackageCodemodRunMode(
	value: string,
): PackageCodemodRunMode | null {
	for (const mode of packageCodemodRunModes) {
		if (mode === value) return mode
	}
	return null
}

function parseScope(
	body: object,
	mode: PackageCodemodRunMode,
): { ok: true; scope: PackageCodemodRunScope } | { ok: false; error: string } {
	const record = body as Record<string, unknown>
	const scopeMissing = !Object.hasOwn(record, 'scope') || record.scope == null
	if (scopeMissing) {
		if (mode === 'apply' || mode === 'revert') {
			return {
				ok: false,
				error: 'scope is required for apply and revert modes.',
			}
		}
		return { ok: true, scope: { kind: 'fleet' } }
	}
	const scopeValue = record.scope
	if (scopeValue === 'fleet') {
		return { ok: true, scope: { kind: 'fleet' } }
	}
	if (typeof scopeValue === 'object' && scopeValue !== null) {
		const userId = readNonEmptyTrimmedString(scopeValue, 'userId')
		if (!userId) {
			return {
				ok: false,
				error: 'scope.userId is required when scope is a user object.',
			}
		}
		return { ok: true, scope: { kind: 'user', userId } }
	}
	return {
		ok: false,
		error: 'scope must be "fleet" or { userId }.',
	}
}

function formatScopeForAudit(scope: PackageCodemodRunScope): string {
	switch (scope.kind) {
		case 'fleet':
			return 'fleet'
		case 'user':
			return `user:${scope.userId}`
		default: {
			const exhaustive: never = scope
			return String(exhaustive)
		}
	}
}

function parseFilters(body: object):
	| {
			ok: true
			filters?: { userIds?: Array<string>; packageIds?: Array<string> }
	  }
	| { ok: false; error: string } {
	const record = body as Record<string, unknown>
	if (!Object.hasOwn(record, 'filters') || record.filters == null) {
		return { ok: true }
	}
	const filtersValue = record.filters
	if (typeof filtersValue !== 'object' || filtersValue === null) {
		return { ok: false, error: 'filters must be an object.' }
	}
	const filtersRecord = filtersValue as Record<string, unknown>
	const userIds = parseOptionalStringArray(filtersRecord, 'userIds')
	if (userIds === false) {
		return { ok: false, error: 'filters.userIds must be an array of strings.' }
	}
	if (userIds === 'empty') {
		return {
			ok: false,
			error:
				'filters.userIds was supplied but contained no usable ids. Omit the key, or provide at least one non-empty id.',
		}
	}
	const packageIds = parseOptionalStringArray(filtersRecord, 'packageIds')
	if (packageIds === false) {
		return {
			ok: false,
			error: 'filters.packageIds must be an array of strings.',
		}
	}
	if (packageIds === 'empty') {
		return {
			ok: false,
			error:
				'filters.packageIds was supplied but contained no usable ids. Omit the key, or provide at least one non-empty id.',
		}
	}
	if (!userIds && !packageIds) {
		return { ok: true }
	}
	return {
		ok: true,
		filters: {
			...(userIds ? { userIds } : {}),
			...(packageIds ? { packageIds } : {}),
		},
	}
}

function parseOptionalStringArray(
	record: Record<string, unknown>,
	key: string,
): Array<string> | undefined | false | 'empty' {
	if (!Object.hasOwn(record, key) || record[key] == null) {
		return undefined
	}
	const value = record[key]
	if (!Array.isArray(value)) return false
	const items: Array<string> = []
	for (const entry of value) {
		if (typeof entry !== 'string') return false
		const trimmed = entry.trim()
		if (trimmed) items.push(trimmed)
	}
	return items.length > 0 ? items : 'empty'
}
