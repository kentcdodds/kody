import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { type SecretScope } from './types.ts'

const accountSecretsApprovePath = '/account/secrets/approve'
export const maxBulkPackageSecretApprovalNames = 40
const secretNamePattern = /^[a-zA-Z0-9._-]+$/

export function buildSecretPackageApprovalUrl(input: {
	baseUrl: string
	name: string
	scope: SecretScope
	packageId: string
	kodyId: string | null
	storageContext: StorageContext | null
}) {
	if (input.scope === 'package' && !input.storageContext?.packageId) {
		throw new Error(
			'storageContext.packageId is required for package-scope approvals.',
		)
	}
	if (input.scope === 'session' && !input.storageContext?.sessionId) {
		throw new Error(
			'storageContext.sessionId is required for session-scope approvals.',
		)
	}
	const secretPath = buildAccountSecretPath({
		name: input.name,
		scope: input.scope,
		packageId: input.storageContext?.packageId ?? null,
		sessionId: input.storageContext?.sessionId ?? null,
	})
	const url = new URL(secretPath, input.baseUrl)
	url.searchParams.set('package_id', input.packageId)
	if (input.kodyId) {
		url.searchParams.set('package', input.kodyId)
	}
	return url.toString()
}

export function normalizeBulkPackageSecretApprovalNames(names: Array<string>) {
	const normalized: Array<string> = []
	const seen = new Set<string>()
	for (const rawName of names) {
		const name = rawName.trim()
		if (!name || !secretNamePattern.test(name) || seen.has(name)) continue
		seen.add(name)
		normalized.push(name)
		if (normalized.length >= maxBulkPackageSecretApprovalNames) break
	}
	return normalized
}

export function buildSecretPackageBulkApprovalUrl(input: {
	baseUrl: string
	packageId: string
	kodyId: string | null
	names: Array<string>
}) {
	const names = normalizeBulkPackageSecretApprovalNames(input.names)
	if (names.length === 0) {
		throw new Error('At least one secret name is required for bulk approval.')
	}
	const url = new URL(accountSecretsApprovePath, input.baseUrl)
	url.searchParams.set('package_id', input.packageId)
	if (input.kodyId) {
		url.searchParams.set('package', input.kodyId)
	}
	url.searchParams.set('names', names.join(','))
	return url.toString()
}

export function buildSecretPackageBulkApprovalUrlIfNeeded(input: {
	baseUrl: string
	packageId: string
	kodyId: string | null
	names: Array<string>
}) {
	const names = normalizeBulkPackageSecretApprovalNames(input.names)
	if (names.length < 2) return null
	return buildSecretPackageBulkApprovalUrl({
		baseUrl: input.baseUrl,
		packageId: input.packageId,
		kodyId: input.kodyId,
		names,
	})
}
