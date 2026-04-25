import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { decryptStringWithPurpose, encryptStringWithPurpose } from './crypto.ts'
import { type SecretScope } from './types.ts'

const secretPackageApprovalPurpose = 'secret-package-approval'
const defaultSecretPackageApprovalTtlMs = 1000 * 60 * 60 * 24

export type SecretPackageApprovalRequest = {
	kind: 'package'
	userId: string
	name: string
	scope: SecretScope
	packageId: string
	packageKodyId: string | null
	storageContext: StorageContext | null
	iat: number
	exp: number
}

export async function createSecretPackageApprovalToken(
	env: Pick<Env, 'COOKIE_SECRET'>,
	input: {
		userId: string
		name: string
		scope: SecretScope
		packageId: string
		packageKodyId: string | null
		storageContext: StorageContext | null
		ttlMs?: number
	},
) {
	const now = Date.now()
	const ttlMs = input.ttlMs ?? defaultSecretPackageApprovalTtlMs
	return encryptStringWithPurpose(
		env,
		secretPackageApprovalPurpose,
		JSON.stringify({
			kind: 'package',
			userId: input.userId,
			name: input.name.trim(),
			scope: input.scope,
			packageId: input.packageId.trim(),
			packageKodyId: input.packageKodyId?.trim() || null,
			storageContext: input.storageContext ?? null,
			iat: now,
			exp: now + ttlMs,
		} satisfies SecretPackageApprovalRequest),
	)
}

export async function verifySecretPackageApprovalToken(
	env: Pick<Env, 'COOKIE_SECRET'>,
	token: string,
) {
	const raw = await decryptStringWithPurpose(
		env,
		secretPackageApprovalPurpose,
		token,
	)
	const parsed = JSON.parse(raw) as Partial<SecretPackageApprovalRequest>
	if (
		parsed.kind !== 'package' ||
		typeof parsed.userId !== 'string' ||
		typeof parsed.name !== 'string' ||
		typeof parsed.scope !== 'string' ||
		typeof parsed.packageId !== 'string'
	) {
		throw new Error('Invalid secret package approval request.')
	}
	if (typeof parsed.exp === 'number' && Date.now() > parsed.exp) {
		throw new Error('Secret package approval request has expired.')
	}
	return {
		kind: 'package',
		userId: parsed.userId,
		name: parsed.name.trim(),
		scope: parsed.scope as SecretScope,
		packageId: parsed.packageId.trim(),
		packageKodyId:
			typeof parsed.packageKodyId === 'string'
				? (parsed.packageKodyId.trim() || null)
				: null,
		storageContext: parsed.storageContext ?? null,
		iat: typeof parsed.iat === 'number' ? parsed.iat : Date.now(),
		exp: typeof parsed.exp === 'number' ? parsed.exp : Date.now(),
	} satisfies SecretPackageApprovalRequest
}

export function buildSecretPackageApprovalTokenUrl(input: {
	baseUrl: string
	token: string
	name: string
	scope: SecretScope
	packageId: string
	packageKodyId: string | null
	storageContext: StorageContext | null
}) {
	const secretPath = buildAccountSecretPath({
		name: input.name,
		scope: input.scope,
		appId: input.storageContext?.appId ?? null,
		sessionId: input.storageContext?.sessionId ?? null,
	})
	const url = new URL(secretPath, input.baseUrl)
	url.searchParams.set('package_id', input.packageId)
	if (input.packageKodyId) {
		url.searchParams.set('package', input.packageKodyId)
	}
	url.searchParams.set('request', input.token)
	return url.toString()
}
