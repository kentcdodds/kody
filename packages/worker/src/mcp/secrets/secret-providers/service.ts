import { McpCallerError } from '#mcp/caller-error.ts'
import { resolveSecret } from '#mcp/secrets/service.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { resolvePackageStorageOwnerUserId } from '#worker/package-registry/share-grants.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { buildSecretProviderPackageApprovalUrl } from './approval-url.ts'
import {
	isCanonicalProviderRef,
	tryCanonicalizeProviderRef,
} from './canonicalize.ts'
import { readDeclaredSecretProviderId } from './declared-provider.ts'
import {
	createBrokenProviderRefMessage,
	createMissingProviderBindingMessage,
	createMissingProviderDoorSecretMessage,
	createProviderErrorMessage,
	createProviderNoWebsitesMessage,
	createProviderPackageMismatchMessage,
	createProviderPackageNotGrantedMessage,
	SecretProviderError,
} from './errors.ts'
import { assertSecretProvidersEnabled } from './flag.ts'
import { normalizeProviderHosts } from './hosts.ts'
import { readProviderSecretCache, writeProviderSecretCache } from './cache.ts'
import {
	deleteSecretProviderBinding,
	deleteSecretProviderGrant,
	getSecretProviderBinding,
	getSecretProviderGrant,
	insertSecretProviderGrant,
	listSecretProviderBindings,
	listSecretProviderGrantsForPackage,
	upsertSecretProviderBinding,
} from './repo.ts'
import {
	maxSecretProviderConfigKeys,
	maxSecretProviderConfigValueLength,
	maxSecretProviderRefLength,
	secretProviderIdPattern,
	type ResolvedProviderSecret,
	type SecretProviderBindingRecord,
	type SecretProviderConfig,
	type SecretProviderInvokeInput,
	type SealedProviderCanonicalizeResult,
	type SealedProviderResolveResult,
} from './types.ts'

export type SecretProviderInvoker = (
	input: SecretProviderInvokeInput & {
		env: Env
		baseUrl: string
		ownerUserId: string
		savedPackage: SavedPackageRecord
	},
) => Promise<SealedProviderCanonicalizeResult | SealedProviderResolveResult>

function normalizeProviderId(providerId: string) {
	const trimmed = providerId.trim().toLowerCase()
	if (!secretProviderIdPattern.test(trimmed)) {
		throw new SecretProviderError(
			`Secret provider id "${providerId}" is invalid.`,
		)
	}
	return trimmed
}

function normalizeProviderRef(ref: string) {
	const trimmed = ref.trim()
	if (!trimmed || trimmed.length > maxSecretProviderRefLength) {
		throw new SecretProviderError(createBrokenProviderRefMessage('unknown'))
	}
	return trimmed
}

export function normalizeSecretProviderConfig(
	config: Record<string, unknown> | null | undefined,
): SecretProviderConfig {
	if (!config) return {}
	const normalized: SecretProviderConfig = {}
	for (const [rawKey, value] of Object.entries(config)) {
		const key = rawKey.trim()
		if (!key || typeof value !== 'string') {
			throw new SecretProviderError(
				'Secret provider config values must be strings.',
			)
		}
		if (value.length > maxSecretProviderConfigValueLength) {
			throw new SecretProviderError(
				'Secret provider config values are too long.',
			)
		}
		normalized[key] = value
		if (Object.keys(normalized).length > maxSecretProviderConfigKeys) {
			throw new SecretProviderError(
				`Secret provider config may have at most ${maxSecretProviderConfigKeys} keys.`,
			)
		}
	}
	return normalized
}

async function requireOwnedPackage(input: {
	db: D1Database
	userId: string
	packageId: string
}) {
	const savedPackage = await getSavedPackageById(input.db, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		throw new McpCallerError('Saved package not found for this user.')
	}
	return savedPackage
}

export async function bindSecretProvider(input: {
	env: Env
	baseUrl: string
	userId: string
	providerId: string
	packageId: string
	doorSecretName: string
	config?: Record<string, unknown> | null
}) {
	await assertSecretProvidersEnabled({
		db: input.env.APP_DB,
		stableUserId: input.userId,
	})
	const providerId = normalizeProviderId(input.providerId)
	const doorSecretName = input.doorSecretName.trim()
	if (!doorSecretName) {
		throw new SecretProviderError('A door-key secret name is required.')
	}
	const savedPackage = await requireOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
	})
	const declaredId = await readDeclaredSecretProviderId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		savedPackage,
	})
	if (declaredId !== providerId) {
		throw new SecretProviderError(
			createProviderPackageMismatchMessage({
				providerId,
				packageName: savedPackage.kodyId,
			}),
		)
	}
	const doorSecret = await resolveSecret({
		env: input.env,
		userId: input.userId,
		name: doorSecretName,
		scope: 'user',
		storageContext: null,
	})
	if (!doorSecret.found) {
		throw new SecretProviderError(
			createMissingProviderDoorSecretMessage({
				providerId,
				doorSecretName,
			}),
		)
	}
	const config = normalizeSecretProviderConfig(input.config)
	await upsertSecretProviderBinding(input.env.APP_DB, {
		userId: input.userId,
		providerId,
		packageId: savedPackage.id,
		doorSecretName,
		configJson: JSON.stringify(config),
	})
	return {
		providerId,
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		doorSecretName,
		config,
	}
}

export async function unbindSecretProvider(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	providerId: string
}) {
	await assertSecretProvidersEnabled({
		db: input.env.APP_DB,
		stableUserId: input.userId,
	})
	const providerId = normalizeProviderId(input.providerId)
	await deleteSecretProviderBinding(input.env.APP_DB, {
		userId: input.userId,
		providerId,
	})
	return { providerId }
}

export async function listBoundSecretProviders(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	await assertSecretProvidersEnabled({
		db: input.env.APP_DB,
		stableUserId: input.userId,
	})
	return await listSecretProviderBindings(input.env.APP_DB, {
		userId: input.userId,
	})
}

export async function grantSecretProviderToPackage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	providerId: string
	ref: string
	packageId: string
}) {
	await assertSecretProvidersEnabled({
		db: input.env.APP_DB,
		stableUserId: input.userId,
	})
	const providerId = normalizeProviderId(input.providerId)
	const canonicalRef = requireLocalCanonicalRef(providerId, input.ref)
	const savedPackage = await requireOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
	})
	await insertSecretProviderGrant(input.env.APP_DB, {
		userId: input.userId,
		providerId,
		canonicalRef,
		packageId: savedPackage.id,
	})
	return {
		providerId,
		canonicalRef,
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
	}
}

export async function revokeSecretProviderGrant(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	providerId: string
	ref: string
	packageId: string
}) {
	await assertSecretProvidersEnabled({
		db: input.env.APP_DB,
		stableUserId: input.userId,
	})
	const providerId = normalizeProviderId(input.providerId)
	const canonicalRef = requireLocalCanonicalRef(providerId, input.ref)
	await deleteSecretProviderGrant(input.env.APP_DB, {
		userId: input.userId,
		providerId,
		canonicalRef,
		packageId: input.packageId,
	})
}

export async function inspectSecretProviderPackageGrant(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	providerId: string
	ref: string
	packageId: string
}) {
	await assertSecretProvidersEnabled({
		db: input.env.APP_DB,
		stableUserId: input.userId,
	})
	const providerId = normalizeProviderId(input.providerId)
	const canonicalRef = requireLocalCanonicalRef(providerId, input.ref)
	const savedPackage = await requireOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
	})
	const grant = await getSecretProviderGrant(input.env.APP_DB, {
		userId: input.userId,
		providerId,
		canonicalRef,
		packageId: savedPackage.id,
	})
	return {
		providerId,
		canonicalRef,
		alreadyGranted: grant != null,
		savedPackage: {
			id: savedPackage.id,
			kodyId: savedPackage.kodyId,
		},
	}
}

export async function listSecretProviderGrants(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	packageId: string
}) {
	await assertSecretProvidersEnabled({
		db: input.env.APP_DB,
		stableUserId: input.userId,
	})
	return await listSecretProviderGrantsForPackage(input.env.APP_DB, input)
}

function requireLocalCanonicalRef(providerId: string, ref: string) {
	const canonicalRef =
		tryCanonicalizeProviderRef(normalizeProviderRef(ref)) ??
		(isCanonicalProviderRef(ref) ? ref.trim() : null)
	if (!canonicalRef) {
		throw new SecretProviderError(createBrokenProviderRefMessage(providerId))
	}
	return canonicalRef
}

export async function resolveProviderSecret(input: {
	env: Env
	baseUrl: string
	userId: string
	provider: string
	ref: string
	storageContext?: StorageContext | null
	authorityPackageId?: string | null
	invokeProvider: SecretProviderInvoker
}): Promise<ResolvedProviderSecret> {
	const providerId = normalizeProviderId(input.provider)
	const rawRef = normalizeProviderRef(input.ref)
	const authorityPackageId = input.authorityPackageId?.trim() || null
	const ownerUserId = authorityPackageId
		? await resolvePackageStorageOwnerUserId({
				db: input.env.APP_DB,
				callerUserId: input.userId,
				packageId: authorityPackageId,
			})
		: input.userId
	await assertSecretProvidersEnabled({
		db: input.env.APP_DB,
		stableUserId: ownerUserId,
	})
	const binding = await getSecretProviderBinding(input.env.APP_DB, {
		userId: ownerUserId,
		providerId,
	})
	if (!binding) {
		throw new SecretProviderError(
			createMissingProviderBindingMessage(providerId),
		)
	}
	const providerPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: ownerUserId,
		packageId: binding.packageId,
	})
	if (!providerPackage) {
		throw new SecretProviderError(
			createMissingProviderBindingMessage(providerId),
		)
	}
	const declaredId = await readDeclaredSecretProviderId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: ownerUserId,
		savedPackage: providerPackage,
	})
	if (declaredId !== providerId) {
		throw new SecretProviderError(
			createProviderPackageMismatchMessage({
				providerId,
				packageName: providerPackage.kodyId,
			}),
		)
	}
	const canonicalRef = await resolveCanonicalProviderRef({
		env: input.env,
		baseUrl: input.baseUrl,
		ownerUserId,
		providerId,
		rawRef,
		binding,
		providerPackage,
		invokeProvider: input.invokeProvider,
	})
	if (authorityPackageId) {
		await assertProviderGrant({
			db: input.env.APP_DB,
			baseUrl: input.baseUrl,
			ownerUserId,
			callerUserId: input.userId,
			providerId,
			canonicalRef,
			packageId: authorityPackageId,
		})
	}
	const cached = readProviderSecretCache({
		userId: ownerUserId,
		providerId,
		canonicalRef,
	})
	if (cached) {
		return {
			provider: providerId,
			ref: rawRef,
			canonicalRef,
			value: cached.value,
			hosts: cached.hosts,
		}
	}
	const doorSecret = await resolveSecret({
		env: input.env,
		userId: ownerUserId,
		name: binding.doorSecretName,
		scope: 'user',
		storageContext: null,
	})
	if (!doorSecret.found || typeof doorSecret.value !== 'string') {
		throw new SecretProviderError(
			createMissingProviderDoorSecretMessage({
				providerId,
				doorSecretName: binding.doorSecretName,
			}),
		)
	}
	let resolved: SealedProviderResolveResult
	try {
		const result = await input.invokeProvider({
			env: input.env,
			baseUrl: input.baseUrl,
			ownerUserId,
			savedPackage: providerPackage,
			action: 'resolve',
			providerId,
			ref: rawRef,
			canonicalRef,
			doorSecretName: binding.doorSecretName,
			doorSecretValue: doorSecret.value,
			config: binding.config,
		})
		resolved = parseSealedResolveResult(providerId, result)
	} catch (error) {
		if (error instanceof SecretProviderError) throw error
		throw new SecretProviderError(createProviderErrorMessage(providerId), {
			cause: error,
		})
	}
	const hosts = normalizeProviderHosts(resolved.hosts)
	if (hosts.length === 0) {
		throw new SecretProviderError(createProviderNoWebsitesMessage(providerId))
	}
	writeProviderSecretCache({
		userId: ownerUserId,
		providerId,
		canonicalRef,
		value: resolved.value,
		hosts,
	})
	return {
		provider: providerId,
		ref: rawRef,
		canonicalRef,
		value: resolved.value,
		hosts,
	}
}

async function resolveCanonicalProviderRef(input: {
	env: Env
	baseUrl: string
	ownerUserId: string
	providerId: string
	rawRef: string
	binding: SecretProviderBindingRecord
	providerPackage: SavedPackageRecord
	invokeProvider: SecretProviderInvoker
}) {
	const local = tryCanonicalizeProviderRef(input.rawRef)
	if (local) return local
	const doorSecret = await resolveSecret({
		env: input.env,
		userId: input.ownerUserId,
		name: input.binding.doorSecretName,
		scope: 'user',
		storageContext: null,
	})
	if (!doorSecret.found || typeof doorSecret.value !== 'string') {
		throw new SecretProviderError(
			createMissingProviderDoorSecretMessage({
				providerId: input.providerId,
				doorSecretName: input.binding.doorSecretName,
			}),
		)
	}
	try {
		const result = await input.invokeProvider({
			env: input.env,
			baseUrl: input.baseUrl,
			ownerUserId: input.ownerUserId,
			savedPackage: input.providerPackage,
			action: 'canonicalize',
			providerId: input.providerId,
			ref: input.rawRef,
			canonicalRef: null,
			doorSecretName: input.binding.doorSecretName,
			doorSecretValue: doorSecret.value,
			config: input.binding.config,
		})
		const canonicalRef =
			'canonicalRef' in result && typeof result.canonicalRef === 'string'
				? (tryCanonicalizeProviderRef(result.canonicalRef) ??
					(isCanonicalProviderRef(result.canonicalRef)
						? result.canonicalRef.trim()
						: null))
				: null
		if (!canonicalRef) {
			throw new SecretProviderError(
				createBrokenProviderRefMessage(input.providerId),
			)
		}
		return canonicalRef
	} catch (error) {
		if (error instanceof SecretProviderError) throw error
		throw new SecretProviderError(
			createBrokenProviderRefMessage(input.providerId),
			{
				cause: error,
			},
		)
	}
}

async function assertProviderGrant(input: {
	db: D1Database
	baseUrl: string
	ownerUserId: string
	callerUserId: string
	providerId: string
	canonicalRef: string
	packageId: string
}) {
	const grant = await getSecretProviderGrant(input.db, {
		userId: input.ownerUserId,
		providerId: input.providerId,
		canonicalRef: input.canonicalRef,
		packageId: input.packageId,
	})
	if (grant) return
	const savedPackage = await getSavedPackageById(input.db, {
		userId: input.ownerUserId,
		packageId: input.packageId,
	})
	const packageName = savedPackage?.kodyId ?? input.packageId
	const approvalUrl = buildSecretProviderPackageApprovalUrl({
		baseUrl: input.baseUrl,
		providerId: input.providerId,
		canonicalRef: input.canonicalRef,
		packageId: input.packageId,
		kodyId: savedPackage?.kodyId ?? null,
	})
	throw new SecretProviderError(
		createProviderPackageNotGrantedMessage({
			providerId: input.providerId,
			canonicalRef: input.canonicalRef,
			packageName,
			approvalUrl,
		}),
	)
}

function parseSealedResolveResult(
	providerId: string,
	result: SealedProviderCanonicalizeResult | SealedProviderResolveResult,
): SealedProviderResolveResult {
	if (!('value' in result) || typeof result.value !== 'string') {
		throw new SecretProviderError(createProviderErrorMessage(providerId))
	}
	if (!Array.isArray(result.hosts)) {
		throw new SecretProviderError(createProviderErrorMessage(providerId))
	}
	const hosts = result.hosts.filter((host) => typeof host === 'string')
	return { value: result.value, hosts }
}

export { getSecretProviderBinding }
