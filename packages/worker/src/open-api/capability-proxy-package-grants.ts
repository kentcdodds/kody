import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	type AdditionalKodyTools,
	type PackageSecretToolOptions,
} from '#mcp/runtime-helper-manifest.ts'
import { takeSecretAuthorityFromCapabilityArgs } from '#mcp/secrets/secret-authority.ts'
import { authorize, packageResource } from '#worker/authorization/authorize.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	createPackageStorageAccessDeniedMessage,
	createPackageStorageKodyTools,
} from '#worker/storage-runner.ts'
import { resolvePackageMountedSecret } from '#mcp/secrets/package-access.ts'
import { authorizeAmbientSecretUse } from '#worker/authorization/credential-use.ts'

/**
 * Local-execute CapabilityProxy packageStorage / packageSecrets host tools.
 *
 * Cloud execute builds a bundler provenance grant set once per run. Local
 * execute has no sandbox graph on origin per hop, so each call validates the
 * stamped package id is in the org and the actor holds `package:execute` on
 * it before packageStorage. Client-stamped package ids are not secret
 * authority: packageSecrets also require `secret:use` on the mounted secret
 * (same as ad-hoc). Gateway / authenticatedFetch / oauthClientCredentials
 * never promote a client stamp to Use-skip either.
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
	const orgUserId = ownerIdFromCaller(input.callerContext)
	if (!orgUserId) {
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
		env: input.env,
		request: input.callerContext.request,
		orgUserId,
		packageId,
	})
	return {
		userId: orgUserId,
		packageId: authorizedPackageId,
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

/**
 * Confirm the stamped package lives in the bound org and the acting person
 * holds `package:execute` on it. Org ownership alone is not enough: a member
 * with execute on package A must not stamp package B to skip ad-hoc
 * credential Use checks.
 */
export async function authorizeLocalExecuteOwnedPackageId(input: {
	db: D1Database
	env: Env
	request: RequestContext | null
	orgUserId: string
	packageId: string
}) {
	const owned = await getSavedPackageById(input.db, {
		userId: input.orgUserId,
		packageId: input.packageId,
	})
	if (!owned) {
		throw new Error(createPackageStorageAccessDeniedMessage(input.packageId))
	}
	await authorize(
		{ env: input.env, request: input.request },
		'package:execute',
		packageResource({
			id: input.packageId,
			userId: input.orgUserId,
			label: owned.name || owned.kodyId,
		}),
	)
	return input.packageId
}

export async function createCapabilityProxyPackageHostTools(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<AdditionalKodyTools> {
	const orgUserId = ownerIdFromCaller(input.callerContext)
	if (!orgUserId) return {}

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

	const requireUseForMountedSecret = async (inputMount: {
		packageId: string
		alias: string
	}) => {
		const orgUserId = ownerIdFromCaller(input.callerContext)
		if (!orgUserId) {
			throw new Error('packageSecrets require an authenticated user.')
		}
		const mounted = await resolvePackageMountedSecret({
			env: input.env,
			callerContext: input.callerContext,
			packageId: inputMount.packageId,
			alias: inputMount.alias,
		})
		// Client-claimed package identity is not bundler provenance: ad-hoc Use
		// still applies for org-shared credentials.
		await authorizeAmbientSecretUse({
			env: input.env,
			request: input.callerContext.request,
			orgUserId,
			secretName: mounted.name,
			authorityPackageId: null,
		})
		return mounted
	}

	const packageSecretTools: PackageSecretToolOptions = {
		runPackageId: null,
		get: async (alias, requestedPackageId) => {
			const authorized = await resolveSecretAuthority(
				requestedPackageId ?? null,
			)
			return (
				await requireUseForMountedSecret({
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
				await requireUseForMountedSecret({
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
