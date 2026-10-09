export type PackageCodemodFinding = {
	path: string | null
	message: string
}

export type PackageCodemodTransformResult = {
	files: Record<string, string>
	changed: boolean
	changedPaths: Array<string>
	needsManual: Array<PackageCodemodFinding>
}

/** Host facts about the package being repaired, never read from its files. */
export type PackageCodemodContext = {
	/** Registry name (`@org/kody-id`); its scope is the owning org. */
	packageName: string
}

export type PackageCodemod = {
	id: string
	description: string
	detect(
		files: Record<string, string>,
		context: PackageCodemodContext,
	): Array<PackageCodemodFinding>
	transform(
		files: Record<string, string>,
		context: PackageCodemodContext,
	): PackageCodemodTransformResult
}
