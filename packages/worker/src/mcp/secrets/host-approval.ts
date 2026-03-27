import { decryptStringWithPurpose, encryptStringWithPurpose } from './crypto.ts'
import { normalizeHost } from './allowed-hosts.ts'
import { type SecretContext, type SecretScope } from './types.ts'

const secretHostApprovalPurpose = 'secret-host-approval'
const defaultSecretHostApprovalTtlMs = 1000 * 60 * 60 * 24

export type SecretHostApprovalRequest = {
	userId: string
	name: string
	scope: SecretScope
	requestedHost: string
	secretContext: SecretContext | null
	iat: number
	exp: number
}

export async function createSecretHostApprovalToken(
	env: Pick<Env, 'COOKIE_SECRET'>,
	input: {
		userId: string
		name: string
		scope: SecretScope
		requestedHost: string
		secretContext: SecretContext | null
		ttlMs?: number
	},
) {
	const now = Date.now()
	const ttlMs = input.ttlMs ?? defaultSecretHostApprovalTtlMs
	return encryptStringWithPurpose(
		env,
		secretHostApprovalPurpose,
		JSON.stringify({
			userId: input.userId,
			name: input.name.trim(),
			scope: input.scope,
			requestedHost: normalizeHost(input.requestedHost),
			secretContext: input.secretContext ?? null,
			iat: now,
			exp: now + ttlMs,
		} satisfies SecretHostApprovalRequest),
	)
}

export async function verifySecretHostApprovalToken(
	env: Pick<Env, 'COOKIE_SECRET'>,
	token: string,
) {
	const raw = await decryptStringWithPurpose(
		env,
		secretHostApprovalPurpose,
		token,
	)
	const parsed = JSON.parse(raw) as Partial<SecretHostApprovalRequest>
	if (
		typeof parsed.userId !== 'string' ||
		typeof parsed.name !== 'string' ||
		typeof parsed.scope !== 'string' ||
		typeof parsed.requestedHost !== 'string'
	) {
		throw new Error('Invalid secret host approval request.')
	}
	if (typeof parsed.exp === 'number' && Date.now() > parsed.exp) {
		throw new Error('Secret host approval request has expired.')
	}
	return {
		userId: parsed.userId,
		name: parsed.name.trim(),
		scope: parsed.scope as SecretScope,
		requestedHost: normalizeHost(parsed.requestedHost),
		secretContext: parsed.secretContext ?? null,
		iat: typeof parsed.iat === 'number' ? parsed.iat : Date.now(),
		exp: typeof parsed.exp === 'number' ? parsed.exp : Date.now(),
	} satisfies SecretHostApprovalRequest
}

export function buildSecretHostApprovalUrl(baseUrl: string, token: string) {
	const url = new URL('/account/secrets/approve', baseUrl)
	url.searchParams.set('request', token)
	return url.toString()
}
