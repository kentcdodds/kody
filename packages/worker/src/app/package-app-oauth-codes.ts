import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import {
	serializePackageAppOauthScopes,
	type PackageAppOauthScope,
} from '#app/package-app-oauth-scopes.ts'

const codeTtlMs = 60_000
const codeKvPrefix = 'package-app-oauth-code:'
const codeKvTtlSeconds = 60

export type PackageAppOauthCodeRecord = {
	personId: string
	username: string
	orgUsername: string
	kodyId: string
	redirectUri: string
	codeChallenge: string
	scopes: Array<PackageAppOauthScope>
	sessionExpiresAt: number
	exp: number
}

function randomCodePlaintext() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

export async function mintPackageAppOauthCode(input: {
	env: Env
	record: Omit<PackageAppOauthCodeRecord, 'exp'>
	now?: number
}): Promise<{ code: string; expiresAt: number } | null> {
	const store = input.env.BUNDLE_ARTIFACTS_KV
	if (!store) return null
	const now = input.now ?? Date.now()
	const code = randomCodePlaintext()
	const exp = now + codeTtlMs
	const hash = await sha256Base64Url(code)
	await store.put(
		`${codeKvPrefix}${hash}`,
		JSON.stringify({
			...input.record,
			exp,
		} satisfies PackageAppOauthCodeRecord),
		{ expirationTtl: codeKvTtlSeconds },
	)
	return { code, expiresAt: exp }
}

export async function consumePackageAppOauthCode(input: {
	env: Env
	code: string
	redirectUri: string
	codeVerifier: string
	now?: number
}): Promise<PackageAppOauthCodeRecord | null> {
	const store = input.env.BUNDLE_ARTIFACTS_KV
	if (!store) return null
	const now = input.now ?? Date.now()
	const hash = await sha256Base64Url(input.code)
	const key = `${codeKvPrefix}${hash}`
	const raw = await store.get(key)
	if (!raw) return null
	// Burn before validating PKCE so a stolen code cannot be retried after a
	// failed verifier guess on a race. KV delete is best-effort.
	await store.delete(key)
	let record: PackageAppOauthCodeRecord
	try {
		record = JSON.parse(raw) as PackageAppOauthCodeRecord
	} catch {
		return null
	}
	if (!record || typeof record !== 'object') return null
	if (record.exp <= now) return null
	if (record.redirectUri !== input.redirectUri) return null
	const challenge = await sha256Base64Url(input.codeVerifier)
	if (challenge !== record.codeChallenge) return null
	return record
}

export function packageAppOauthCodeScopesLabel(
	scopes: ReadonlyArray<PackageAppOauthScope>,
) {
	return serializePackageAppOauthScopes(scopes)
}
