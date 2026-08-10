import * as Sentry from '@sentry/cloudflare'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { upsertSavedPackageVector } from './vectorize.ts'

/**
 * Deferred saved-package vector upserts must not fail silently. Before
 * scheduling work on `waitUntil`, mark debt; clear it on success; keep it
 * (with the error) on failure and report to Sentry. Capability reindex also
 * clears debt after a successful upsert so search converges even if the
 * original waitUntil never ran.
 */

export async function markSavedPackageSearchIndexDebt(input: {
	db: D1Database
	packageId: string
	userId: string
	lastError?: string | null
}) {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO saved_package_search_index_debt (
				package_id, user_id, last_error, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(package_id) DO UPDATE SET
				user_id = excluded.user_id,
				last_error = excluded.last_error,
				updated_at = excluded.updated_at`,
		)
		.bind(input.packageId, input.userId, input.lastError ?? null, now, now)
		.run()
}

export async function clearSavedPackageSearchIndexDebt(input: {
	db: D1Database
	packageId: string
}) {
	await input.db
		.prepare(`DELETE FROM saved_package_search_index_debt WHERE package_id = ?`)
		.bind(input.packageId)
		.run()
}

export async function listSavedPackageSearchIndexDebt(input: {
	db: D1Database
	limit: number
}): Promise<Array<{ packageId: string; userId: string }>> {
	const rows = await input.db
		.prepare(
			`SELECT package_id, user_id
			FROM saved_package_search_index_debt
			ORDER BY updated_at ASC
			LIMIT ?`,
		)
		.bind(input.limit)
		.all<{ package_id: string; user_id: string }>()
	return (rows.results ?? []).map((row) => ({
		packageId: row.package_id,
		userId: row.user_id,
	}))
}

function logSavedPackageSearchIndexError(input: {
	packageId: string
	userId: string
	error: unknown
}) {
	console.error(
		JSON.stringify({
			message: 'saved package search index upsert failed',
			packageId: input.packageId,
			userId: input.userId,
			error: getErrorMessage(input.error),
		}),
	)
	Sentry.captureException(input.error, {
		tags: {
			scope: 'saved-package-search-index',
			action: 'upsert',
		},
		extra: {
			packageId: input.packageId,
			userId: input.userId,
		},
	})
}

/**
 * Upsert the package vector after the response when `waitUntil` is available;
 * otherwise await (same observability either way). Debt is marked before the
 * work starts so a dropped waitUntil still leaves a reconcile target.
 */
export async function scheduleSavedPackageSearchIndexUpsert(input: {
	env: Env
	packageId: string
	userId: string
	embedText: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	await markSavedPackageSearchIndexDebt({
		db: input.env.APP_DB,
		packageId: input.packageId,
		userId: input.userId,
	})

	const task = (async () => {
		await upsertSavedPackageVector(input.env, {
			packageId: input.packageId,
			userId: input.userId,
			embedText: input.embedText,
		})
		await clearSavedPackageSearchIndexDebt({
			db: input.env.APP_DB,
			packageId: input.packageId,
		})
	})().catch(async (error: unknown) => {
		try {
			await markSavedPackageSearchIndexDebt({
				db: input.env.APP_DB,
				packageId: input.packageId,
				userId: input.userId,
				lastError: getErrorMessage(error),
			})
		} catch (debtError) {
			console.error(
				JSON.stringify({
					message: 'failed to persist search index debt after upsert failure',
					packageId: input.packageId,
					error: getErrorMessage(debtError),
				}),
			)
		}
		logSavedPackageSearchIndexError({
			packageId: input.packageId,
			userId: input.userId,
			error,
		})
	})

	if (input.waitUntil) {
		input.waitUntil(task)
		return
	}
	await task
}
