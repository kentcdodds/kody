import { McpCallerError } from '#mcp/caller-error.ts'
import {
	countPackageIdentityFields,
	normalizePackageNameInput,
	packageIdentityChoiceDescription,
} from '#worker/package-registry/package-name.ts'
import {
	getSavedPackageById,
	getSavedPackageByKodyId,
} from '#worker/package-registry/repo.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

export type PackageSourceIdentity = {
	package_id?: string
	package_name?: string
}

function requireExactlyOnePackageSourceIdentity(input: PackageSourceIdentity) {
	if (countPackageIdentityFields(input) !== 1) {
		throw new McpCallerError(packageIdentityChoiceDescription)
	}
}

export async function resolveOwnedPackageSource(input: {
	db: D1Database
	userId: string
	ownerScope: string
	args: PackageSourceIdentity
}): Promise<{
	packageId: string
	packageName: string
	kodyId: string
	name: string
	hasApp: boolean
	source: EntitySourceRow
}> {
	requireExactlyOnePackageSourceIdentity(input.args)
	const packageSlug =
		input.args.package_name === undefined
			? undefined
			: normalizePackageNameInput({
					value: input.args.package_name,
					ownerScope: input.ownerScope,
					action: 'resolve',
				})
	const savedPackage =
		input.args.package_id !== undefined
			? await getSavedPackageById(input.db, {
					userId: input.userId,
					packageId: input.args.package_id,
				})
			: await getSavedPackageByKodyId(input.db, {
					userId: input.userId,
					kodyId: packageSlug ?? '',
				})
	if (!savedPackage) {
		const missingId = input.args.package_id ?? input.args.package_name
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
		packageName: savedPackage.kodyId,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		hasApp: savedPackage.hasApp,
		source,
	}
}
