import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	listSavedPackagesPage,
	setSavedPackagePrivacy,
} from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import {
	createStableUserIdFromEmail,
	normalizeStableUserId,
} from '#worker/user-id.ts'

type MaintenanceResult = Record<string, unknown> & { ok?: never }

export class MaintenanceFailureError extends Error {
	readonly result: MaintenanceResult

	constructor(message: string, result: MaintenanceResult) {
		super(message)
		this.name = 'MaintenanceFailureError'
		this.result = result
	}
}

type SecretMaintenanceRequestInput = {
	request: Request
	secret: string | null | undefined
	notConfiguredMessage: string
	run: () => Promise<MaintenanceResult>
}

function readBearerToken(request: Request) {
	const auth = request.headers.get('Authorization')?.trim()
	return auth?.startsWith('Bearer ')
		? auth.slice('Bearer '.length).trim()
		: null
}

export async function handleSecretMaintenanceRequest(
	input: SecretMaintenanceRequestInput,
): Promise<Response> {
	if (input.request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}

	const secret = input.secret?.trim()
	if (!secret) {
		return new Response(input.notConfiguredMessage, { status: 503 })
	}

	if (readBearerToken(input.request) !== secret) {
		return new Response('Unauthorized', { status: 401 })
	}

	try {
		const result = await input.run()
		return Response.json({ ...result, ok: true })
	} catch (error) {
		if (error instanceof MaintenanceFailureError) {
			return Response.json(
				{ ...error.result, ok: false, error: error.message },
				{ status: 500 },
			)
		}
		return Response.json(
			{ ok: false, error: getErrorMessage(error) },
			{ status: 500 },
		)
	}
}

export const stableUserIdBackfillBatchSize = 100

/**
 * Persist the stable user id (SHA-256 of the normalized email) for every
 * pre-materialization users row that still has a NULL `stable_user_id`. The
 * production deploy runs this migration before installing code that requires
 * indexed stable ids. Pages with a keyset on `id` in batches of 100 to stay
 * within D1 limits on large tables. Per-row failures (for example two rows
 * whose emails normalize to the same hash colliding on the unique index) are
 * counted for the deploy step to reject.
 */
export async function backfillStableUserIds(input: {
	db: D1Database
	batchSize?: number
}) {
	const batchSize = input.batchSize ?? stableUserIdBackfillBatchSize
	let lastId = 0
	let scanned = 0
	let backfilled = 0
	let failed = 0
	for (;;) {
		const { results } = await input.db
			.prepare(
				`SELECT id, email, stable_user_id FROM users
				 WHERE id > ? ORDER BY id ASC LIMIT ?`,
			)
			.bind(lastId, batchSize)
			.all<{ id: number; email: string; stable_user_id: string | null }>()
		const rows = results ?? []
		for (const row of rows) {
			lastId = row.id
			scanned += 1
			if (normalizeStableUserId(row.stable_user_id)) continue
			try {
				const result = await input.db
					.prepare(
						`UPDATE users SET stable_user_id = ?
						 WHERE id = ? AND stable_user_id IS NULL`,
					)
					.bind(await createStableUserIdFromEmail(row.email), row.id)
					.run()
				backfilled += result.meta.changes ?? 0
			} catch (error) {
				failed += 1
				console.warn('stable-user-id-backfill-row-failed', row.id, error)
			}
		}
		if (rows.length < batchSize) break
	}
	return { scanned, backfilled, failed }
}

/**
 * `POST /__maintenance/backfill-stable-user-ids`: one-off/idempotent backfill
 * of `users.stable_user_id` for the production deploy migration, authenticated
 * like the reindex endpoints (Bearer `CAPABILITY_REINDEX_SECRET`).
 */
export async function handleStableUserIdBackfillRequest(
	request: Request,
	env: Pick<Env, 'APP_DB' | 'CAPABILITY_REINDEX_SECRET'>,
): Promise<Response> {
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Stable user id backfill is not configured',
		run: () => backfillStableUserIds({ db: env.APP_DB }),
	})
}

export const packagePrivacyBackfillPageSize = 200

/**
 * Persist `saved_packages.is_private` from each package's package.json
 * `private` field. Existing rows defaulted to private (1) in migration 0065
 * because manifests live in KV and cannot be read from SQL; this endpoint
 * pages through saved packages and corrects the projection.
 */
export async function backfillPackagePrivacy(input: {
	env: Env
	baseUrl: string
	pageSize?: number
}) {
	const pageSize = input.pageSize ?? packagePrivacyBackfillPageSize
	let afterId: string | null = null
	let scanned = 0
	let updated = 0
	let failed = 0
	for (;;) {
		const rows = await listSavedPackagesPage(input.env.APP_DB, {
			afterId,
			limit: pageSize,
		})
		if (rows.length === 0) break
		for (const row of rows) {
			afterId = row.id
			scanned += 1
			try {
				const { manifest } = await loadPackageManifestBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: row.userId,
					sourceId: row.sourceId,
				})
				const isPrivate = manifest.private === true
				if (row.isPrivate === isPrivate) continue
				const changed = await setSavedPackagePrivacy(input.env.APP_DB, {
					userId: row.userId,
					packageId: row.id,
					isPrivate,
				})
				if (changed) updated += 1
			} catch (error) {
				failed += 1
				console.warn('package-privacy-backfill-row-failed', row.id, error)
			}
		}
		if (rows.length < pageSize) break
	}
	return { scanned, updated, failed }
}

/**
 * `POST /__maintenance/backfill-package-privacy`: one-off/idempotent backfill
 * of `saved_packages.is_private` from package manifests, authenticated like
 * the reindex endpoints (Bearer `CAPABILITY_REINDEX_SECRET`).
 */
export async function handlePackagePrivacyBackfillRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const url = new URL(request.url)
	return handleSecretMaintenanceRequest({
		request,
		secret: env.CAPABILITY_REINDEX_SECRET,
		notConfiguredMessage: 'Package privacy backfill is not configured',
		run: () =>
			backfillPackagePrivacy({
				env,
				baseUrl: url.origin,
			}),
	})
}
