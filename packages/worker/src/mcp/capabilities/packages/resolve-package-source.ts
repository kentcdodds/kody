import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
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
		throw new Error('Provide exactly one of `package_id` or `kody_id`.')
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
		throw new Error(`Saved package "${missingId}" was not found.`)
	}
	const source = await getEntitySourceById(input.db, savedPackage.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error('Repo source was not found for this user.')
	}
	return {
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		source,
	}
}
