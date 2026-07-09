import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { buildSecretPackageApprovalUrl } from './package-approval-url.ts'
import {
	createMissingSecretMessage,
	createPackageSecretAccessDeniedBatchMessage,
	createPackageSecretAccessDeniedMessage,
} from './errors.ts'
import { resolveSecret, type ResolvedSecret } from './service.ts'
import { type SecretScope } from './types.ts'
import {
	loadPackageManifestBySourceId,
	type LoadedPackageManifest,
} from '#worker/package-registry/source.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'

type SecretMountDefinition = {
	name: string
	scope?: SecretScope
}

export class PackageSecretMountError extends Error {}
export class PackageSecretMissingError extends Error {}
export class PackageSecretAccessDeniedError extends Error {}

export function isPackageSecretAccessUnavailableError(error: unknown) {
	return (
		error instanceof PackageSecretMountError ||
		error instanceof PackageSecretMissingError ||
		error instanceof PackageSecretAccessDeniedError
	)
}

export async function assertPackageCanAccessResolvedSecret(input: {
	env: Pick<Env, 'APP_DB'>
	baseUrl: string
	userId: string
	storageContext:
		| {
				sessionId?: string | null
				appId?: string | null
				packageId?: string | null
				storageId?: string | null
		  }
		| null
		| undefined
	secretName: string
	resolved: ResolvedSecret
}) {
	const packageId = input.storageContext?.packageId?.trim()
	if (!packageId || input.resolved.scope !== 'user') return
	if (input.resolved.allowedPackages.includes(packageId)) return

	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId,
	})
	if (!savedPackage) {
		throw new PackageSecretAccessDeniedError(
			`Package "${packageId}" was not found for secret access.`,
		)
	}
	const approvalUrl = buildSecretPackageApprovalUrl({
		baseUrl: input.baseUrl,
		name: input.secretName,
		scope: 'user',
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		storageContext: {
			sessionId: input.storageContext?.sessionId ?? null,
			appId: input.storageContext?.appId ?? null,
			packageId: input.storageContext?.packageId ?? null,
			storageId: input.storageContext?.storageId ?? null,
		},
	})
	throw new PackageSecretAccessDeniedError(
		createPackageSecretAccessDeniedMessage({
			secretName: input.secretName,
			packageName: savedPackage.kodyId,
			approvalUrl,
		}),
	)
}

export async function loadPackageSecretMounts(input: {
	env: Env
	baseUrl: string
	userId: string
	packageId: string
}): Promise<{
	savedPackage: {
		id: string
		kodyId: string
		name: string
		sourceId: string
	}
	manifest: LoadedPackageManifest['manifest']
	mounts: Record<string, SecretMountDefinition>
}> {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		throw new Error(`Saved package "${input.packageId}" was not found.`)
	}
	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: savedPackage.sourceId,
	})
	return {
		savedPackage: {
			id: savedPackage.id,
			kodyId: savedPackage.kodyId,
			name: savedPackage.name,
			sourceId: savedPackage.sourceId,
		},
		manifest: loaded.manifest,
		mounts: loaded.manifest.kody.secretMounts ?? {},
	}
}

export async function resolvePackageMountedSecret(input: {
	env: Env
	callerContext: McpCallerContext
	packageId: string
	alias: string
}) {
	const packageContext = input.callerContext.storageContext?.packageId
	if (!packageContext || packageContext !== input.packageId) {
		throw new Error(
			'Package secret access requires a matching server-side package runtime context.',
		)
	}
	const userId = input.callerContext.user?.userId
	if (!userId) {
		throw new Error(
			'Package secret access requires an authenticated package caller context.',
		)
	}
	const packageInfo = await loadPackageSecretMounts({
		env: input.env,
		baseUrl: input.callerContext.baseUrl,
		userId,
		packageId: input.packageId,
	})
	const mount = packageInfo.mounts[input.alias]
	if (!mount) {
		throw new PackageSecretMountError(
			`Package "${packageInfo.savedPackage.kodyId}" does not declare secret mount "${input.alias}".`,
		)
	}
	const resolved = await resolveSecret({
		env: input.env,
		userId,
		name: mount.name,
		scope: mount.scope,
		storageContext: {
			sessionId: input.callerContext.storageContext?.sessionId ?? null,
			appId: input.callerContext.storageContext?.appId ?? null,
			packageId: input.callerContext.storageContext?.packageId ?? null,
			storageId: input.callerContext.storageContext?.storageId ?? null,
		},
	})
	if (!resolved.found || typeof resolved.value !== 'string') {
		throw new PackageSecretMissingError(createMissingSecretMessage(mount.name))
	}
	await assertPackageCanAccessResolvedSecret({
		env: input.env,
		baseUrl: input.callerContext.baseUrl,
		userId,
		storageContext: input.callerContext.storageContext,
		secretName: mount.name,
		resolved,
	})
	return {
		alias: input.alias,
		name: mount.name,
		value: resolved.value,
		scope: resolved.scope ?? mount.scope ?? 'user',
		packageId: packageInfo.savedPackage.id,
		kodyId: packageInfo.savedPackage.kodyId,
	}
}

export async function findMissingPackageApprovals(input: {
	env: Env
	baseUrl: string
	userId: string
	packageId: string
	mounts: Record<string, SecretMountDefinition>
	storageContext: McpCallerContext['storageContext']
}) {
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId: input.packageId,
	})
	if (!savedPackage) {
		throw new Error(`Saved package "${input.packageId}" was not found.`)
	}
	const storageContext = {
		sessionId: input.storageContext?.sessionId ?? null,
		appId: input.storageContext?.appId ?? null,
		packageId: input.storageContext?.packageId ?? null,
		storageId: input.storageContext?.storageId ?? null,
	}
	const entries = await Promise.all(
		Object.values(input.mounts).map(async (mount) => {
			const resolved = await resolveSecret({
				env: input.env,
				userId: input.userId,
				name: mount.name,
				scope: mount.scope,
				storageContext,
			})
			if (!resolved.found) return null
			if (resolved.scope !== 'user') return null
			if (resolved.allowedPackages.includes(savedPackage.id)) {
				return null
			}
			return {
				secretName: mount.name,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				approvalUrl: buildSecretPackageApprovalUrl({
					baseUrl: input.baseUrl,
					name: mount.name,
					scope: resolved.scope ?? mount.scope ?? 'user',
					packageId: savedPackage.id,
					kodyId: savedPackage.kodyId,
					storageContext,
				}),
			}
		}),
	)
	return entries.filter((entry) => entry != null)
}

export function buildPackageApprovalErrorForMounts(input: {
	entries: Array<{
		secretName: string
		packageId: string
		kodyId: string
		approvalUrl: string
	}>
}) {
	if (input.entries.length === 0) {
		return null
	}
	if (input.entries.length === 1) {
		const only = input.entries[0]
		if (!only) return null
		return createPackageSecretAccessDeniedMessage({
			secretName: only.secretName,
			packageName: only.kodyId,
			approvalUrl: only.approvalUrl,
		})
	}
	return createPackageSecretAccessDeniedBatchMessage(
		input.entries.map((entry) => ({
			secretName: entry.secretName,
			packageId: entry.packageId,
			kodyId: entry.kodyId,
			packageName: entry.kodyId,
			approvalUrl: entry.approvalUrl,
		})),
	)
}
