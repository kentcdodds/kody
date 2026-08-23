export type PackageInvokeCallShape = 'legacy_object' | 'string_first'

export type PackageInvokeRuntimeSurface = 'execute' | 'package' | 'app' | 'job'

export type PackageInvokeCallTelemetryEnv = {
	PACKAGE_INVOKE_EVENTS?: AnalyticsEngineDataset
}

/**
 * Classifies the host-bridge envelope, not package source. String-first calls
 * arrive as `{ specifier, options }`; all object-only calls use the legacy
 * envelope.
 */
export function classifyPackageInvokeCallShape(
	input: Record<string, unknown>,
): PackageInvokeCallShape {
	return typeof input['specifier'] === 'string'
		? 'string_first'
		: 'legacy_object'
}

/**
 * Records only the API shape and coarse runtime surface. The data point has no
 * user, package, export, source, parameter, or other caller-controlled value.
 * Recording is non-blocking, never throws, and is a no-op without the binding.
 */
export function recordPackageInvokeCall(
	env: PackageInvokeCallTelemetryEnv,
	input: {
		callShape: PackageInvokeCallShape
		surface: PackageInvokeRuntimeSurface
	},
): void {
	try {
		env.PACKAGE_INVOKE_EVENTS?.writeDataPoint({
			indexes: [input.callShape],
			blobs: [input.callShape, input.surface],
			doubles: [1],
		})
	} catch (error) {
		console.warn('package-invoke-event-failed', error)
	}
}
