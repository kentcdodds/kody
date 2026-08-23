import { resolveSavedPackageImport } from '#worker/package-runtime/package-import-resolution.ts'
import { type ParsedPackageInvokeInput } from './input-parsing.ts'
import { resolveSavedPackage } from './module-artifacts.ts'

export async function resolvePackageInvokeTarget(input: {
	env: Env
	userId: string
	packageIdentifier: ParsedPackageInvokeInput['packageIdentifier']
}) {
	switch (input.packageIdentifier.kind) {
		case 'specifier': {
			const resolved = await resolveSavedPackageImport({
				db: input.env.APP_DB,
				userId: input.userId,
				specifier: input.packageIdentifier.value,
			})
			return resolved
				? {
						savedPackage: resolved.row,
						sourceOwnerUserId: resolved.sourceOwnerUserId,
					}
				: null
		}
		case 'kodyId':
		case 'packageId': {
			const savedPackage = await resolveSavedPackage({
				db: input.env.APP_DB,
				userId: input.userId,
				packageIdOrKodyId: input.packageIdentifier.value,
			})
			return savedPackage
				? { savedPackage, sourceOwnerUserId: input.userId }
				: null
		}
		default: {
			const packageIdentifier: never = input.packageIdentifier
			void packageIdentifier
			throw new Error('Unhandled package invoke identifier.')
		}
	}
}
