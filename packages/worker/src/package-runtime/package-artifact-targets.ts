import {
	getPackageAppEntryPath,
	listPackageServices,
	listPackageSubscriptions,
	normalizePackageWorkspacePath,
} from '#worker/package-registry/manifest.ts'
import {
	type AuthoredPackageJson,
	type PackageExportTarget,
} from '#worker/package-registry/types.ts'
import { type BundleArtifactKind } from './published-runtime-artifacts.ts'
import { buildPackageSubscriptionArtifactName } from './subscription-artifacts.ts'

export type PublishedPackageArtifactBuildTarget = {
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
	bundleKind: 'app' | 'module' | 'importable-module'
}

function resolvePackageExportRuntimeEntryPoint(target: PackageExportTarget) {
	return typeof target === 'string'
		? target
		: (target.import ?? target.default ?? null)
}

export function collectPublishedPackageArtifactTargets(
	manifest: AuthoredPackageJson,
) {
	const targets: Array<PublishedPackageArtifactBuildTarget> = []
	if (manifest.kody.app) {
		const entryPoint = getPackageAppEntryPath(manifest)
		if (entryPoint) {
			targets.push({
				kind: 'app',
				entryPoint,
				bundleKind: 'app',
			})
		}
	}
	for (const service of listPackageServices(manifest)) {
		targets.push({
			kind: 'service',
			artifactName: service.name,
			entryPoint: service.entry,
			bundleKind: 'module',
		})
	}
	for (const [exportName, exportTarget] of Object.entries(manifest.exports)) {
		const entryPoint = resolvePackageExportRuntimeEntryPoint(exportTarget)
		if (!entryPoint) continue
		const normalizedEntryPoint = normalizePackageWorkspacePath(entryPoint)
		targets.push({
			kind: 'module',
			artifactName: exportName,
			entryPoint: normalizedEntryPoint,
			bundleKind: 'module',
		})
		targets.push({
			kind: 'importable-module',
			artifactName: exportName,
			entryPoint: normalizedEntryPoint,
			bundleKind: 'importable-module',
		})
	}
	for (const subscription of listPackageSubscriptions(manifest)) {
		targets.push({
			kind: 'module',
			artifactName: buildPackageSubscriptionArtifactName(subscription.topic),
			entryPoint: subscription.handler,
			bundleKind: 'module',
		})
	}
	for (const [jobName, jobDefinition] of Object.entries(
		manifest.kody.jobs ?? {},
	)) {
		targets.push({
			kind: 'job',
			artifactName: jobName,
			entryPoint: normalizePackageWorkspacePath(jobDefinition.entry),
			bundleKind: 'module',
		})
	}
	return targets
}
