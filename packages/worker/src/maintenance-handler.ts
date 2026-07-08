import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
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
 * legacy users row that still has a NULL `stable_user_id`, so lookups hit the
 * partial unique index (migration 0052) instead of the scan fallback. Pages
 * with a keyset on `id` in batches of 100 to stay within D1 limits on large
 * tables. Per-row failures (for example two rows whose emails normalize to
 * the same hash colliding on the unique index) are counted, not fatal.
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
 * of `users.stable_user_id` for legacy rows, authenticated like the reindex
 * endpoints (Bearer `CAPABILITY_REINDEX_SECRET`).
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
