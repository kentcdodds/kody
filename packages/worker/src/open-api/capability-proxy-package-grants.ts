import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	type AdditionalKodyTools,
	type PackageSecretToolOptions,
} from '#mcp/runtime-helper-manifest.ts'
import { takeSecretAuthorityFromCapabilityArgs } from '#mcp/secrets/secret-authority.ts'
import {
	collectShareStorageOwners,
	retainAuthorizedPackageStorageGrantIds,
} from '#worker/package-registry/share-grants.ts'
import {
	createPackageStorageAccessDeniedMessage,
	createPackageStorageKodyTools,
} from '#worker/storage-runner.ts'
import { resolvePackageMountedSecret } from '#mcp/secrets/package-access.ts'

/**
 * Local-execute CapabilityProxy packageStorage / packageSecrets host tools.
 *
 * Cloud execute builds a bundler provenance grant set once per run. Local
 * execute has no sandbox graph on origin per hop, so each call validates the
 * stamped package id against caller ownership before running the ordinary
 * storage / mounted-secret tools for that single id. Nested static imports
 * stamp gatewayFetch via the local meter ALS (see local-execute-runtime-support)
 * so package-scoped secrets align with cloud without a run-wide grant set.
 */

function isPackageSecretAvailabilityError(error: unknown) {
	return (
		error instanceof Error &&
		(error.message.startsWith('Secret "') ||
			error.message.startsWith('Package "'))
	)
}

async function authorizeLocalExecutePackageId(input: {
	env: Env
	callerContext: McpCallerContext
	packageId: string
}) {
	const userId = input.callerContext.user?.userId
	if (!userId) {
		throw new Error(
			'packageStorage / packageSecrets require an authenticated user.',
		)
	}
	const packageId = input.packageId.trim()
	if (!packageId) {
		throw new Error('packageStorage requires a non-empty package id.')
	}
	const authorizedPackageId = await authorizeLocalExecuteOwnedPackageId({
		db: input.env.APP_DB,
		callerUserId: userId,
		packageId,
	})
	return {
		userId,
		packageId: authorizedPackageId,
		storageOwnerByPackageId: new Map(),
		grantedPackageIds: new Set([authorizedPackageId]),
	}
}

function readPackageIdFromStorageArgs(args: unknown) {
	if (args == null || typeof args !== 'object' || Array.isArray(args)) {
		return ''
	}
	return typeof (args as { packageId?: unknown }).packageId === 'string'
		? String((args as { packageId: string }).packageId).trim()
		: ''
}

function readPackageSecretCall(args: unknown) {
	const { args: peeled, requestedPackageId } =
		takeSecretAuthorityFromCapabilityArgs([args])
	const first = peeled[0]
	const alias =
		typeof first === 'object' && first !== null && 'alias' in first
			? String((first as { alias: unknown }).alias ?? '').trim()
			: ''
	return { alias, requestedPackageId }
}

export async function authorizeLocalExecuteOwnedPackageId(input: {
	db: D1Database
	callerUserId: string
	packageId: string
}) {
	const storageOwnerByPackageId = await collectShareStorageOwners({
		db: input.db,
		callerUserId: personIdFromStored(input.callerUserId),
		packageIds: [input.packageId],
	})
	const authorized = await retainAuthorizedPackageStorageGrantIds({
		db: input.db,
		callerUserId: input.callerUserId,
		packageIds: [input.packageId],
		storageOwnerByPackageId: new Map(),
	})
	if (authorized.has(input.packageId)) return input.packageId
	if (storageOwnerByPackageId.has(input.packageId)) {
		throw new Error(
			'Shared packages cannot use packageStorage, packageSecrets, authenticatedFetch, gatewayFetch, or oauthClientCredentials on execute --local. Use cloud execute.',
		)
	}
	throw new Error(createPackageStorageAccessDeniedMessage(input.packageId))
}

export async function createCapabilityProxyPackageHostTools(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<AdditionalKodyTools> {
	const userId = input.callerContext.user?.userId
	if (!userId) return {}

	const storageToolsByPackageId = new Map<
		string,
		ReturnType<typeof createPackageStorageKodyTools>
	>()

	const storageToolsFor = async (packageId: string) => {
		const authorized = await authorizeLocalExecutePackageId({
			env: input.env,
			callerContext: input.callerContext,
			packageId,
		})
		let tools = storageToolsByPackageId.get(authorized.packageId)
		if (!tools) {
			tools = createPackageStorageKodyTools({
				env: input.env,
				userId: authorized.userId,
				email: input.callerContext.user?.email ?? null,
				grantedPackageIds: authorized.grantedPackageIds,
				writable: true,
				storageOwnerByPackageId: authorized.storageOwnerByPackageId,
			})
			storageToolsByPackageId.set(authorized.packageId, tools)
		}
		return tools
	}

	const resolveSecretAuthority = async (requestedPackageId: string | null) => {
		if (!requestedPackageId) {
			throw new Error(
				'Package secret access requires a matching server-side package runtime context.',
			)
		}
		return authorizeLocalExecutePackageId({
			env: input.env,
			callerContext: input.callerContext,
			packageId: requestedPackageId,
		})
	}

	const packageSecretTools: PackageSecretToolOptions = {
		runPackageId: null,
		get: async (alias, requestedPackageId) => {
			const authorized = await resolveSecretAuthority(
				requestedPackageId ?? null,
			)
			return (
				await resolvePackageMountedSecret({
					env: input.env,
					callerContext: input.callerContext,
					packageId: authorized.packageId,
					alias,
				})
			).ref
		},
		has: async (alias, requestedPackageId) => {
			const authorized = await resolveSecretAuthority(
				requestedPackageId ?? null,
			)
			try {
				await resolvePackageMountedSecret({
					env: input.env,
					callerContext: input.callerContext,
					packageId: authorized.packageId,
					alias,
				})
				return true
			} catch (error) {
				if (isPackageSecretAvailabilityError(error)) return false
				throw error
			}
		},
	}

	return {
		packageStorageGet: async (args: unknown) =>
			(
				await storageToolsFor(readPackageIdFromStorageArgs(args))
			).packageStorageGet(args),
		packageStorageList: async (args: unknown) =>
			(
				await storageToolsFor(readPackageIdFromStorageArgs(args))
			).packageStorageList(args),
		packageStorageSql: async (args: unknown) =>
			(
				await storageToolsFor(readPackageIdFromStorageArgs(args))
			).packageStorageSql(args),
		packageStorageSet: async (args: unknown) =>
			(await storageToolsFor(readPackageIdFromStorageArgs(args)))
				.packageStorageSet!(args),
		packageStorageDelete: async (args: unknown) =>
			(await storageToolsFor(readPackageIdFromStorageArgs(args)))
				.packageStorageDelete!(args),
		packageStorageClear: async (args: unknown) =>
			(await storageToolsFor(readPackageIdFromStorageArgs(args)))
				.packageStorageClear!(args),
		packageSecretGet: async (args: unknown) => {
			const { alias, requestedPackageId } = readPackageSecretCall(args)
			return {
				value: await packageSecretTools.get(alias, requestedPackageId),
			}
		},
		packageSecretHas: async (args: unknown) => {
			const { alias, requestedPackageId } = readPackageSecretCall(args)
			return {
				has: await packageSecretTools.has(alias, requestedPackageId),
			}
		},
	}
}
