import {
	base64UrlToBytes,
	bytesToBase64Url,
	utf8ToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { isStableUserId } from '#worker/user-id.ts'

/**
 * Cross-site auth handoff for hosted package apps.
 *
 * When package apps are served from their own registrable domain, the app
 * origin's `kody_session` cookie is cross-site and never reaches that host (by
 * design — see docs/contributing/security.md). The app origin therefore mints a
 * short-lived, single-use signed token bound to one user and one package, and
 * the package-app origin exchanges it for its own host-scoped cookie.
 *
 * The token is a bearer credential in a URL, so it is deliberately weak: one
 * minute of validity, bound to the exact package path it was minted for, and
 * burned on first use.
 */

/** Query parameter that carries a freshly minted handoff token. */
export const packageAppHandoffQueryParam = '__kody_handoff'

const handoffTokenTtlMs = 60_000
const handoffSignaturePurpose = 'kody-package-app-handoff:v2'
const handoffReplayKeyPrefix = 'package-app-handoff:'
// Cloudflare KV enforces a 60 second minimum expiration TTL, which matches the
// token lifetime.
const handoffReplayTtlSeconds = 60

export type PackageAppHandoffClaims = {
	stableUserId: string
	username: string
	kodyId: string
}

type StoredHandoffPayload = {
	v: 2
	stableUserId: string
	usr: string
	pkg: string
	exp: number
	jti: string
}

function isStoredHandoffPayload(value: unknown): value is StoredHandoffPayload {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 2 &&
		isStableUserId(record.stableUserId) &&
		typeof record.usr === 'string' &&
		record.usr.length > 0 &&
		typeof record.pkg === 'string' &&
		record.pkg.length > 0 &&
		typeof record.exp === 'number' &&
		Number.isFinite(record.exp) &&
		typeof record.jti === 'string' &&
		record.jti.length > 0
	)
}

async function getHandoffSigningKey(env: Env) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for package app handoff signing.')
	}
	return await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

function signedMessage(payload: string) {
	return new TextEncoder().encode(`${handoffSignaturePurpose}.${payload}`)
}

export async function createPackageAppHandoffToken(input: {
	env: Env
	claims: PackageAppHandoffClaims
	now?: number
}) {
	const now = input.now ?? Date.now()
	const payload = utf8ToBase64Url(
		JSON.stringify({
			v: 2,
			stableUserId: input.claims.stableUserId,
			usr: input.claims.username,
			pkg: input.claims.kodyId,
			exp: now + handoffTokenTtlMs,
			jti: crypto.randomUUID(),
		} satisfies StoredHandoffPayload),
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		await getHandoffSigningKey(input.env),
		signedMessage(payload),
	)
	return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`
}

/**
 * Validate a handoff token for one package path and burn it so it cannot be
 * replayed.
 *
 * The path binding is checked **before** the burn: a token that does not belong
 * to the requested package was never meant for this request, so consuming it
 * would strand a token the owner can still use (a mistyped URL would otherwise
 * cost them a fresh handoff).
 *
 * Replay protection is best effort: it uses eventually consistent KV, and a
 * missing KV binding only disables the replay check. Signature, expiry, and the
 * path binding always fail closed.
 */
export async function consumePackageAppHandoffToken(input: {
	env: Env
	token: string
	expected: Pick<PackageAppHandoffClaims, 'username' | 'kodyId'>
	now?: number
}): Promise<PackageAppHandoffClaims | null> {
	const now = input.now ?? Date.now()
	const [payload, signature, ...rest] = input.token.split('.')
	if (!payload || !signature || rest.length > 0) return null

	let signatureValid: boolean
	try {
		signatureValid = await crypto.subtle.verify(
			'HMAC',
			await getHandoffSigningKey(input.env),
			base64UrlToBytes(signature),
			signedMessage(payload),
		)
	} catch {
		return null
	}
	if (!signatureValid) return null

	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)))
	} catch {
		return null
	}
	if (!isStoredHandoffPayload(parsed)) return null
	if (parsed.exp <= now) return null
	if (
		parsed.usr !== input.expected.username ||
		parsed.pkg !== input.expected.kodyId
	) {
		return null
	}

	const replayStore = input.env.BUNDLE_ARTIFACTS_KV
	if (replayStore) {
		const replayKey = `${handoffReplayKeyPrefix}${parsed.jti}`
		try {
			if (await replayStore.get(replayKey)) return null
			await replayStore.put(replayKey, '1', {
				expirationTtl: handoffReplayTtlSeconds,
			})
		} catch (error) {
			console.warn('Package app handoff replay check failed.', error)
		}
	}

	return {
		stableUserId: parsed.stableUserId,
		username: parsed.usr,
		kodyId: parsed.pkg,
	}
}
