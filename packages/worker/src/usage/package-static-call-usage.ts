import { recordUsage, type UsageEnv } from './record-usage.ts'

/**
 * Host-side sink for `package_static_call` usage events reported by the
 * sandbox-side call-metering wrapper around statically imported package
 * exports (see `__kodyMeterStaticPackageExport` in
 * `packages/worker/src/package-runtime/runtime-source-modules.ts`).
 *
 * Trust model: the callee package id is stamped into generated import-proxy
 * code by the bundler, never taken from author-supplied strings. Generated
 * code still runs inside the sandbox realm, though, so the host validates
 * every reported id against the run's bundler-recorded static dependency
 * provenance (the same grant set `packageStorage()` uses) and silently
 * drops anything else. A malicious module can therefore at worst inflate
 * call counts for packages its own bundle already statically depends on —
 * it can never attribute usage to an arbitrary package.
 *
 * `record` never throws and never rejects: metering must not break the call
 * path it observes (same contract as `recordUsage`).
 */

export type PackageStaticCallMeterInput = Record<string, unknown>

export type PackageStaticCallMeterTools = {
	record: (input: PackageStaticCallMeterInput) => Promise<void>
}

export function createPackageStaticCallMeterTools(input: {
	env: UsageEnv
	userId: string | null | undefined
	/**
	 * Saved-package UUIDs statically loaded into the running bundle, from
	 * bundler/host controlled provenance only (see
	 * `collectPackageStorageGrantIds`). Reported events whose stamped id is
	 * not in this set are dropped.
	 */
	grantedPackageIds: ReadonlySet<string>
}): PackageStaticCallMeterTools | undefined {
	const userId = input.userId?.trim()
	if (!userId) return undefined
	return {
		record: async (rawEvent) => {
			try {
				const packageId =
					typeof rawEvent?.packageId === 'string' ? rawEvent.packageId : ''
				if (!packageId || !input.grantedPackageIds.has(packageId)) {
					console.debug(
						'package-static-call-usage-dropped',
						'stamped package id is not a static dependency of this run',
						packageId,
					)
					return
				}
				const outcome = rawEvent.outcome
				if (outcome !== 'success' && outcome !== 'error') {
					console.debug(
						'package-static-call-usage-dropped',
						'invalid outcome',
						outcome,
					)
					return
				}
				const durationMs =
					typeof rawEvent.durationMs === 'number' &&
					Number.isFinite(rawEvent.durationMs) &&
					rawEvent.durationMs >= 0
						? rawEvent.durationMs
						: null
				await recordUsage(input.env, {
					userId,
					eventType: 'package_static_call',
					entityId: packageId,
					durationMs,
					outcome,
				})
			} catch (error) {
				console.debug('package-static-call-usage-failed', error)
			}
		},
	}
}
