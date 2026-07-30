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
 * every reported id against the bundle's *static* dependency package ids
 * recorded at build time (a strict subset of the `packageStorage()` grant
 * set, which additionally grants the run's own package id and
 * dynamic-import dependencies) and silently drops anything else. A
 * malicious module can therefore at worst inflate call counts for packages
 * its own bundle already statically depends on — it can never attribute
 * usage to an arbitrary package.
 *
 * Events arrive as one batch per run (buffered sandbox-side and flushed by
 * the run wrapper while the sandbox RPC dispatchers are still live); each
 * batch entry becomes one usage event. `record` never throws and never
 * rejects: metering must not break the call path it observes (same
 * contract as `recordUsage`).
 */

export type PackageStaticCallMeterInput = Record<string, unknown>

export type PackageStaticCallMeterTools = {
	record: (input: PackageStaticCallMeterInput) => Promise<void>
}

/**
 * Mirrors the sandbox-side cumulative cap in the static-call meter prelude
 * (`createStaticCallMeterHelperPrelude`), enforced across every batch of
 * one run even for a sandbox that forges oversized payloads. Sized to fit
 * the Workers Analytics Engine budget: 250 `writeDataPoint` calls per
 * invocation, one per event, with headroom left for the run's other usage
 * events.
 */
const maxRecordedEventsPerRun = 200

export function createPackageStaticCallMeterTools(input: {
	env: UsageEnv
	userId: string | null | undefined
	/**
	 * Saved-package UUIDs recorded as static dependencies of the running
	 * bundle at build time (`bundle.dependencies`), from bundler/host
	 * controlled provenance only. Reported events whose stamped id is not
	 * in this set are dropped.
	 */
	grantedPackageIds: ReadonlySet<string>
}): PackageStaticCallMeterTools | undefined {
	const userId = input.userId?.trim()
	if (!userId) return undefined
	let recordedCount = 0
	return {
		record: async (batch) => {
			try {
				const events = Array.isArray(batch?.events) ? batch.events : []
				for (const rawEvent of events.slice(0, maxRecordedEventsPerRun)) {
					if (recordedCount >= maxRecordedEventsPerRun) return
					const recorded = await recordStaticCallEvent({
						env: input.env,
						userId,
						grantedPackageIds: input.grantedPackageIds,
						rawEvent,
					})
					if (recorded) recordedCount += 1
				}
			} catch (error) {
				console.debug('package-static-call-usage-failed', error)
			}
		},
	}
}

/** Returns true when the event was recorded (counts against the run cap). */
async function recordStaticCallEvent(input: {
	env: UsageEnv
	userId: string
	grantedPackageIds: ReadonlySet<string>
	rawEvent: unknown
}) {
	const rawEvent =
		typeof input.rawEvent === 'object' && input.rawEvent !== null
			? (input.rawEvent as Record<string, unknown>)
			: {}
	const packageId =
		typeof rawEvent.packageId === 'string' ? rawEvent.packageId : ''
	if (!packageId || !input.grantedPackageIds.has(packageId)) {
		console.debug(
			'package-static-call-usage-dropped',
			'stamped package id is not a static dependency of this run',
			packageId,
		)
		return false
	}
	const outcome = rawEvent.outcome
	if (outcome !== 'success' && outcome !== 'error') {
		console.debug('package-static-call-usage-dropped', 'invalid outcome')
		return false
	}
	const durationMs =
		typeof rawEvent.durationMs === 'number' &&
		Number.isFinite(rawEvent.durationMs) &&
		rawEvent.durationMs >= 0
			? rawEvent.durationMs
			: null
	await recordUsage(input.env, {
		userId: input.userId,
		eventType: 'package_static_call',
		entityId: packageId,
		durationMs,
		outcome,
	})
	return true
}
