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
	/**
	 * Where the package lives in its repo snapshot, as stored on its entity
	 * source. Omitted means the repo root (`package.json` at `/`).
	 */
	manifestPath?: string
	sourceRoot?: string
}

/**
 * How apply/revert write when Artifacts default-branch HEAD has drifted from
 * `published_commit`.
 *
 * - `head-and-published` (default) — today's path: require HEAD == published,
 *   then `syncArtifactSourceSnapshot` (moves HEAD and published together).
 *   Drifted packages stay `skipped_drift`.
 * - `published-only` — on drift, commit the transformed published tree as a
 *   child of `published_commit`, push to the durable `kody-published` ref, and
 *   advance published via finalize — without moving default-branch HEAD.
 *   Non-drifted applies still use `syncArtifactSourceSnapshot`.
 */
export type PackageCodemodApplyMode = 'head-and-published' | 'published-only'

export type PackageCodemod = {
	id: string
	description: string
	/**
	 * Opt-in write lane for drifted packages. Omit for the historical
	 * head-and-published behavior (fleet default).
	 */
	applyMode?: PackageCodemodApplyMode
	detect(
		files: Record<string, string>,
		context: PackageCodemodContext,
	): Array<PackageCodemodFinding>
	transform(
		files: Record<string, string>,
		context: PackageCodemodContext,
	): PackageCodemodTransformResult
}
