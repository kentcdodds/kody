import { type RunRecordContext } from '#worker/run-records/types.ts'

export type PackageInvokeSpecifierForm = 'kody_prefixed' | 'prefixless'
export type PackageInvokeTelemetrySurface =
	| 'execute'
	| 'package'
	| 'job'
	| 'app'

export type PackageInvokeSpecifierTelemetryEnv = {
	PACKAGE_INVOKE_SPECIFIER_EVENTS?: AnalyticsEngineDataset
}

export function classifyPackageInvokeSpecifierForm(
	rawSpecifier: string,
): PackageInvokeSpecifierForm | null {
	const specifier = rawSpecifier.trim()
	// Classify only from the raw leading form. The parser accepts whitespace
	// inside owner/package segments, and malformed attempts are intentionally
	// counted: false positives delay retirement, while false negatives could
	// incorrectly authorize removing a still-used form.
	if (specifier.startsWith('kody:@')) return 'kody_prefixed'
	if (specifier.startsWith('@')) return 'prefixless'
	return null
}

export function resolvePackageInvokeTelemetrySurface(input: {
	callerKind: 'package' | 'execute'
	parentRunRecord?: RunRecordContext | null
	runtimeSurface?: 'app'
}): PackageInvokeTelemetrySurface {
	if (input.parentRunRecord?.surface === 'job') return 'job'
	if (input.runtimeSurface === 'app') return 'app'
	if (input.callerKind === 'execute') return 'execute'
	return 'package'
}

/**
 * Records only the raw specifier form and coarse runtime surface. The event
 * intentionally contains no user, package, specifier, export, params, source,
 * run, or request identity. Recording is synchronous, nonthrowing, and a no-op
 * when the dedicated Analytics Engine binding is absent.
 */
export function recordPackageInvokeSpecifierForm(
	env: PackageInvokeSpecifierTelemetryEnv,
	input: {
		rawSpecifier: string
		surface: PackageInvokeTelemetrySurface
	},
): void {
	const form = classifyPackageInvokeSpecifierForm(input.rawSpecifier)
	if (!form) return
	try {
		env.PACKAGE_INVOKE_SPECIFIER_EVENTS?.writeDataPoint({
			// Keep sampling independent by form so low-volume prefixless calls
			// remain visible during retirement.
			indexes: [form],
			blobs: [form, input.surface],
			doubles: [1],
		})
	} catch (error) {
		console.warn('package-invoke-specifier-event-failed', error)
	}
}
