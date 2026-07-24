import { McpCallerError } from '#mcp/caller-error.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

export type PackageSourceIdentity = {
	package_id?: string
	kody_id?: string
}

function requireExactlyOnePackageSourceIdentity(input: PackageSourceIdentity) {
	const count =
		(input.package_id !== undefined ? 1 : 0) +
		(input.kody_id !== undefined ? 1 : 0)
	if (count !== 1) {
		throw new McpCallerError(
			'Provide exactly one of `package_id` or `kody_id`.',
		)
	}
}

export async function resolveOwnedPackageSource(input: {
	db: D1Database
	userId: string
	args: PackageSourceIdentity
}): Promise<{
	packageId: string
	kodyId: string
	name: string
	source: EntitySourceRow
}> {
	requireExactlyOnePackageSourceIdentity(input.args)
	const savedPackage =
		input.args.package_id !== undefined
			? await getSavedPackageById(input.db, {
					userId: input.userId,
					packageId: input.args.package_id,
				})
			: await getSavedPackageByKodyId(input.db, {
					userId: input.userId,
					kodyId: input.args.kody_id ?? '',
				})
	if (!savedPackage) {
		const missingId = input.args.package_id ?? input.args.kody_id
		throw new McpCallerError(`Saved package "${missingId}" was not found.`)
	}
	const source = await getEntitySourceByIdForUser(input.db, {
		id: savedPackage.sourceId,
		userId: input.userId,
	})
	if (!source) {
		throw new McpCallerError('Repo source was not found for this user.')
	}
	return {
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		source,
	}
}
