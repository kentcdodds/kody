import { ambientStorageToPackageStorageCodemod } from './codemods/0001-ambient-storage-to-package-storage.ts'
import { staticFirstInvocationCodemod } from './codemods/0002-static-first-invocation.ts'
import { heykodyDomainsToKodyCodesCodemod } from './codemods/0003-heykody-domains-to-kody-codes.ts'
import { kodyappsDevToKodyRunCodemod } from './codemods/0004-kodyapps-dev-to-kody-run.ts'
import { type PackageCodemod } from './types.ts'

const packageCodemods: Array<PackageCodemod> = [
	ambientStorageToPackageStorageCodemod,
	staticFirstInvocationCodemod,
	heykodyDomainsToKodyCodesCodemod,
	kodyappsDevToKodyRunCodemod,
]

const packageCodemodsById = new Map(
	packageCodemods.map((codemod) => [codemod.id, codemod]),
)

export function listPackageCodemods(): Array<{
	id: string
	description: string
}> {
	return packageCodemods.map((codemod) => ({
		id: codemod.id,
		description: codemod.description,
	}))
}

export function getPackageCodemodById(id: string): PackageCodemod | null {
	return packageCodemodsById.get(id) ?? null
}
