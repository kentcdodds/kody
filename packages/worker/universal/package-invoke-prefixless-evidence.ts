export const packageInvokePrefixlessEvidenceEpoch =
	'packages-invoke-prefixless-2026-08-24-v1'

export const packageInvokeEvidenceSurfaces = [
	'execute',
	'package',
	'job',
	'app',
] as const

export type PackageInvokeEvidenceSurface =
	(typeof packageInvokeEvidenceSurfaces)[number]

export type PackageInvokePrefixlessEvidenceCounts = Record<
	PackageInvokeEvidenceSurface,
	number
>

export function emptyPackageInvokePrefixlessEvidenceCounts(): PackageInvokePrefixlessEvidenceCounts {
	return {
		execute: 0,
		package: 0,
		job: 0,
		app: 0,
	}
}

export function isPackageInvokeEvidenceSurface(
	value: string,
): value is PackageInvokeEvidenceSurface {
	return (packageInvokeEvidenceSurfaces as ReadonlyArray<string>).includes(value)
}
