import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	type PackageInvokeCheckResult,
	type PackageInvokeContract,
	type PackageInvokeInput,
} from '#mcp/run-kody-registry.ts'
import {
	buildPackageSearchProjection,
	type PackageExportProjection,
} from '#worker/package-registry/manifest.ts'
import {
	loadPackageManifestBySourceId,
	loadPackageSourceBySourceId,
} from '#worker/package-registry/source.ts'
import {
	buildSavedPackageNotFoundMessage,
	normalizeExportName,
} from './common.ts'
import {
	buildNormalizedPackageInvokeInput,
	parsePackageInvokeInput,
} from './input-parsing.ts'
import {
	ensureModuleArtifact,
	resolvePackageModuleResolution,
	resolveSavedPackage,
} from './module-artifacts.ts'

function createPackageInvokeCheckFailure(input: {
	message: string
	problems: Array<string>
	contract?: Partial<PackageInvokeContract>
}): PackageInvokeCheckResult {
	return {
		ok: false,
		message: input.message,
		problems: input.problems,
		...(input.contract ? { contract: input.contract } : {}),
	}
}

function findPackageExportProjection(input: {
	exports: Array<PackageExportProjection>
	exportName: string
}) {
	return (
		input.exports.find(
			(exportDetail) => exportDetail.subpath === input.exportName,
		) ?? null
	)
}

function buildPackageInvokeCheckWarnings(input: {
	exportDetail: PackageExportProjection | null
	sourceLoadFailed: boolean
}) {
	const warnings = [
		'No machine-readable params schema is published for package exports; params were only validated as a JSON object.',
	]
	if (input.sourceLoadFailed) {
		warnings.push(
			'Source files could not be loaded for metadata extraction; description and type information may be incomplete.',
		)
	}
	if (!input.exportDetail?.typeDefinition) {
		warnings.push(
			'No function type definition was found for this export; callable shape could not be statically confirmed.',
		)
	}
	return warnings
}

/**
 * Everything the check phase already loaded that the invoke phase would
 * otherwise reload from D1/KV: the saved-package row, the current manifest,
 * the resolved module target, and the prepared bundle artifact.
 * `packages.invokeChecked` passes these straight into the invocation so one
 * logical call resolves its package exactly once.
 */
export type PackageInvokeCheckPreloads = {
	savedPackage: NonNullable<Awaited<ReturnType<typeof resolveSavedPackage>>>
	moduleArtifact: Awaited<ReturnType<typeof ensureModuleArtifact>>
}

export type PackageInvokeCheckOutcome = {
	result: PackageInvokeCheckResult
	preloads: PackageInvokeCheckPreloads | null
}

export type PackageInvokeCheckOperationName =
	| 'packages.invoke'
	| 'packages.check'
	/** Deprecated widen-phase alias for `packages.invoke`. */
	| 'packages.invokeChecked'

export async function checkPackageInvokeForRuntime(input: {
	env: Env
	baseUrl: string
	operationName: PackageInvokeCheckOperationName
	userId: string
	rawInput: PackageInvokeInput
}): Promise<PackageInvokeCheckResult> {
	return (
		await checkPackageInvokeForRuntimeWithPreloads({
			...input,
			includeExportProjection: true,
		})
	).result
}

export async function checkPackageInvokeForRuntimeWithPreloads(input: {
	env: Env
	baseUrl: string
	operationName: PackageInvokeCheckOperationName
	userId: string
	rawInput: PackageInvokeInput
	/**
	 * `packages.check` surfaces description / type-definition detail, which
	 * requires the full package source. `packages.invokeChecked` discards the
	 * success contract, so it skips that source load entirely.
	 */
	includeExportProjection: boolean
}): Promise<PackageInvokeCheckOutcome> {
	let request: ReturnType<typeof parsePackageInvokeInput>
	try {
		request = parsePackageInvokeInput(input.rawInput, input.operationName)
	} catch (error) {
		const message = getErrorMessage(error)
		return {
			result: createPackageInvokeCheckFailure({
				message,
				problems: [message],
			}),
			preloads: null,
		}
	}
	const exportName = normalizeExportName(request.exportName)
	const invoke = buildNormalizedPackageInvokeInput({ request, exportName })
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageIdOrKodyId: request.packageIdOrKodyId,
	})
	if (!savedPackage) {
		const message = buildSavedPackageNotFoundMessage(request.packageIdOrKodyId)
		return {
			result: createPackageInvokeCheckFailure({
				message,
				problems: [message],
				contract: { exportName },
			}),
			preloads: null,
		}
	}
	const packageContract = {
		packageId: savedPackage.id,
		kodyId: savedPackage.kodyId,
		name: savedPackage.name,
		sourceId: savedPackage.sourceId,
		exportName,
	}
	let manifestResult: Awaited<ReturnType<typeof loadPackageManifestBySourceId>>
	try {
		manifestResult = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: savedPackage.sourceId,
		})
	} catch (error) {
		const problem = `Could not load current package manifest: ${getErrorMessage(error)}`
		return {
			result: createPackageInvokeCheckFailure({
				message: problem,
				problems: [problem],
				contract: packageContract,
			}),
			preloads: null,
		}
	}
	let resolution: ReturnType<typeof resolvePackageModuleResolution>
	try {
		resolution = resolvePackageModuleResolution({
			manifest: manifestResult.manifest,
			selector: {
				kind: 'export',
				exportName,
			},
		})
	} catch (error) {
		const problem = getErrorMessage(error)
		return {
			result: createPackageInvokeCheckFailure({
				message: problem,
				problems: [problem],
				contract: {
					...packageContract,
					publishedCommit: manifestResult.source.published_commit ?? null,
				},
			}),
			preloads: null,
		}
	}
	let moduleArtifact: Awaited<ReturnType<typeof ensureModuleArtifact>>
	try {
		moduleArtifact = await ensureModuleArtifact({
			env: input.env,
			baseUrl: input.baseUrl,
			packageManifest: manifestResult,
			resolution,
			savedPackage,
			selector: {
				kind: 'export',
				exportName,
			},
			userId: input.userId,
		})
	} catch (error) {
		const problem = `Export "${exportName}" could not be prepared for invocation: ${getErrorMessage(error)}`
		return {
			result: createPackageInvokeCheckFailure({
				message: problem,
				problems: [problem],
				contract: {
					...packageContract,
					publishedCommit: manifestResult.source.published_commit ?? null,
					runtimeTarget: resolution.entryPoint,
				},
			}),
			preloads: null,
		}
	}
	const preloads: PackageInvokeCheckPreloads = {
		savedPackage,
		moduleArtifact,
	}
	if (!input.includeExportProjection) {
		return {
			result: {
				ok: true,
				invoke,
				contract: {
					...packageContract,
					publishedCommit: manifestResult.source.published_commit ?? null,
					runtimeTarget: resolution.entryPoint,
					description: null,
					typeDefinition: null,
					warnings: buildPackageInvokeCheckWarnings({
						exportDetail: null,
						sourceLoadFailed: false,
					}),
				},
			},
			preloads,
		}
	}
	let files: Record<string, string> | undefined
	let sourceLoadFailed = false
	try {
		files = (
			await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				sourceId: savedPackage.sourceId,
			})
		).files
	} catch {
		sourceLoadFailed = true
	}
	const projection = buildPackageSearchProjection(
		manifestResult.manifest,
		files,
	)
	const exportDetail = findPackageExportProjection({
		exports: projection.exports,
		exportName,
	})
	const warnings = buildPackageInvokeCheckWarnings({
		exportDetail,
		sourceLoadFailed,
	})
	return {
		result: {
			ok: true,
			invoke,
			contract: {
				...packageContract,
				publishedCommit: manifestResult.source.published_commit ?? null,
				runtimeTarget: exportDetail?.runtimeTarget ?? resolution.entryPoint,
				description: exportDetail?.description ?? null,
				typeDefinition: exportDetail?.typeDefinition ?? null,
				warnings,
			},
		},
		preloads,
	}
}
