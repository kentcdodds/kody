import { buildAccountSecretUrl } from '@kody-internal/shared/account-secret-route.ts'
import { isSecretExpired } from '@kody-internal/shared/secret-expires-at.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import {
	createMissingSecretMessage,
	createSecretScopeUnavailableMessage,
	type SecretScopeUnavailableMatch,
} from './errors.ts'
import { isReservedSecretName } from './name-guards.ts'
import { listSecretLocationsByNameForUser } from './repo.ts'
import { getSecretBindingKey } from './secret-bindings.ts'
import { type SecretScope } from './types.ts'

const inaccessibleScopeRank: Record<SecretScope, number> = {
	package: 0,
	session: 1,
	user: 2,
}

export async function createUnresolvedSecretMessage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	scope?: SecretScope | null
	storageContext?: StorageContext | null
	baseUrl: string
}) {
	const secretName = input.name.trim()
	if (!secretName) return createMissingSecretMessage(input.name)
	if (!input.env.APP_DB) return createMissingSecretMessage(secretName)
	try {
		const matches = await listInaccessibleSecretMatches({
			env: input.env,
			userId: input.userId,
			name: secretName,
			requestedScope: input.scope ?? null,
			storageContext: input.storageContext ?? null,
			baseUrl: input.baseUrl,
		})
		if (matches.length === 0) return createMissingSecretMessage(secretName)
		return createSecretScopeUnavailableMessage(matches)
	} catch {
		return createMissingSecretMessage(secretName)
	}
}

async function listInaccessibleSecretMatches(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	name: string
	requestedScope: SecretScope | null
	storageContext: StorageContext | null
	baseUrl: string
}): Promise<Array<SecretScopeUnavailableMatch>> {
	if (isReservedSecretName(input.name)) return []
	const locations = await listSecretLocationsByNameForUser({
		db: input.env.APP_DB,
		userId: input.userId,
		name: input.name,
	})
	const inaccessible = locations.filter((location) => {
		if (isSecretExpired(location.expires_at)) return false
		return !isSecretVisibleToLookup({
			scope: location.scope,
			bindingKey: location.binding_key,
			requestedScope: input.requestedScope,
			storageContext: input.storageContext,
		})
	})
	if (inaccessible.length === 0) return []

	const packageIds = [
		...new Set(
			inaccessible
				.filter((location) => location.scope === 'package')
				.map((location) => location.binding_key)
				.filter((packageId) => packageId.length > 0),
		),
	]
	const packageNames = new Map<string, string>()
	await Promise.all(
		packageIds.map(async (packageId) => {
			try {
				const savedPackage = await getSavedPackageById(input.env.APP_DB, {
					userId: input.userId,
					packageId,
				})
				if (savedPackage?.kodyId) {
					packageNames.set(packageId, savedPackage.kodyId)
				}
			} catch {
				// Keep the package id in the error when the title lookup fails.
			}
		}),
	)

	return inaccessible
		.map((location) => {
			const packageId =
				location.scope === 'package' ? location.binding_key : null
			const sessionId =
				location.scope === 'session' ? location.binding_key : null
			return {
				secretName: input.name,
				scope: location.scope,
				packageId,
				packageName: packageId ? (packageNames.get(packageId) ?? null) : null,
				sessionId,
				editorUrl: buildSecretScopeEditorUrl({
					baseUrl: input.baseUrl,
					name: input.name,
					scope: location.scope,
					packageId,
					sessionId,
				}),
			}
		})
		.sort((left, right) => {
			const rankDelta =
				inaccessibleScopeRank[left.scope] - inaccessibleScopeRank[right.scope]
			if (rankDelta !== 0) return rankDelta
			return (left.packageId ?? left.sessionId ?? '').localeCompare(
				right.packageId ?? right.sessionId ?? '',
			)
		})
}

function isSecretVisibleToLookup(input: {
	scope: SecretScope
	bindingKey: string
	requestedScope: SecretScope | null
	storageContext: StorageContext | null
}) {
	if (input.requestedScope && input.requestedScope !== input.scope) {
		return false
	}
	const currentBinding = getSecretBindingKey(input.scope, input.storageContext)
	return currentBinding != null && currentBinding === input.bindingKey
}

function buildSecretScopeEditorUrl(input: {
	baseUrl: string
	name: string
	scope: SecretScope
	packageId: string | null
	sessionId: string | null
}) {
	try {
		return buildAccountSecretUrl({
			baseUrl: input.baseUrl,
			name: input.name,
			scope: input.scope,
			packageId: input.packageId,
			sessionId: input.sessionId,
		})
	} catch {
		return null
	}
}
