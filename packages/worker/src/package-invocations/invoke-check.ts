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
import { normalizeExportName } from './common.ts'
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

export async function checkPackageInvokeForRuntime(input: {
	env: Env
	baseUrl: string
	operationName: 'packages.check' | 'packages.invokeChecked'
	userId: string
	rawInput: PackageInvokeInput
}): Promise<PackageInvokeCheckResult> {
	let request: ReturnType<typeof parsePackageInvokeInput>
	try {
		request = parsePackageInvokeInput(input.rawInput, input.operationName)
	} catch (error) {
		const message = getErrorMessage(error)
		return createPackageInvokeCheckFailure({
			message,
			problems: [message],
		})
	}
	const exportName = normalizeExportName(request.exportName)
	const invoke = buildNormalizedPackageInvokeInput({ request, exportName })
	const savedPackage = await resolveSavedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageIdOrKodyId: request.packageIdOrKodyId,
	})
	if (!savedPackage) {
		const message = `Saved package "${request.packageIdOrKodyId}" was not found for this user.`
		return createPackageInvokeCheckFailure({
			message,
			problems: [message],
			contract: { exportName },
		})
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
		return createPackageInvokeCheckFailure({
			message: problem,
			problems: [problem],
			contract: packageContract,
		})
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
		return createPackageInvokeCheckFailure({
			message: problem,
			problems: [problem],
			contract: {
				...packageContract,
				publishedCommit: manifestResult.source.published_commit ?? null,
			},
		})
	}
	try {
		await ensureModuleArtifact({
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
		return createPackageInvokeCheckFailure({
			message: problem,
			problems: [problem],
			contract: {
				...packageContract,
				publishedCommit: manifestResult.source.published_commit ?? null,
				runtimeTarget: resolution.entryPoint,
			},
		})
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
	}
}
