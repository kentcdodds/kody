import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	listSavedPackagesPage,
	setSavedPackagePrivacy,
} from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'

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

function timingSafeEqualDigests(
	left: ArrayBuffer,
	right: ArrayBuffer,
): boolean {
	if (left.byteLength !== right.byteLength) return false
	const subtleWithTiming = crypto.subtle as SubtleCrypto & {
		timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean
	}
	// Workers expose timingSafeEqual on subtle; Node unit tests do not.
	if (typeof subtleWithTiming.timingSafeEqual === 'function') {
		return subtleWithTiming.timingSafeEqual(left, right)
	}
	const a = new Uint8Array(left)
	const b = new Uint8Array(right)
	let diff = 0
	for (let index = 0; index < a.length; index += 1) {
		diff |= a[index]! ^ b[index]!
	}
	return diff === 0
}

/**
 * Constant-time bearer compare: SHA-256 both sides, then compare digests so
 * length differences do not leak via short-circuit string compares.
 */
export async function timingSafeEqualString(
	left: string,
	right: string,
): Promise<boolean> {
	const encoder = new TextEncoder()
	const [leftDigest, rightDigest] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(left)),
		crypto.subtle.digest('SHA-256', encoder.encode(right)),
	])
	return timingSafeEqualDigests(leftDigest, rightDigest)
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

	const bearer = readBearerToken(input.request)
	if (bearer === null || !(await timingSafeEqualString(bearer, secret))) {
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
