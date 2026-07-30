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

export type PackageCodemod = {
	id: string
	description: string
	detect(files: Record<string, string>): Array<PackageCodemodFinding>
	transform(files: Record<string, string>): PackageCodemodTransformResult
}
