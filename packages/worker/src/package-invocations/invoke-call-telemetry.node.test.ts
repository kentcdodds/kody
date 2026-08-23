import { expect, test, vi } from 'vitest'
import {
	classifyPackageInvokeCallShape,
	recordPackageInvokeCall,
} from './invoke-call-telemetry.ts'
import { resolvePackageInvokeRuntimeSurface } from './runtime-tool-factories.ts'

test('package invoke telemetry distinguishes call shapes without recording identifiers', () => {
	const writeDataPoint = vi.fn()
	const env = {
		PACKAGE_INVOKE_EVENTS: { writeDataPoint },
	}

	expect(
		classifyPackageInvokeCallShape({
			specifier: 'kody:@owner/package/export',
			options: { params: { secret: 'do-not-record' } },
		}),
	).toBe('string_first')
	expect(
		classifyPackageInvokeCallShape({
			kodyId: 'private-package-id',
			exportName: './private-export',
			params: { secret: 'do-not-record' },
		}),
	).toBe('legacy_object')

	recordPackageInvokeCall(env, {
		callShape: 'string_first',
		surface: 'execute',
	})
	recordPackageInvokeCall(env, {
		callShape: 'legacy_object',
		surface: 'job',
	})

	expect(writeDataPoint.mock.calls).toEqual([
		[
			{
				indexes: ['string_first'],
				blobs: ['string_first', 'execute'],
				doubles: [1],
			},
		],
		[
			{
				indexes: ['legacy_object'],
				blobs: ['legacy_object', 'job'],
				doubles: [1],
			},
		],
	])
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toMatch(
		/private-package-id|private-export|do-not-record/,
	)
})

test('package invoke telemetry is optional and never throws', () => {
	expect(() =>
		recordPackageInvokeCall(
			{},
			{ callShape: 'legacy_object', surface: 'package' },
		),
	).not.toThrow()
})

test('package invoke telemetry maps callers to coarse runtime surfaces', () => {
	expect(resolvePackageInvokeRuntimeSurface({ callerKind: 'execute' })).toBe(
		'execute',
	)
	expect(resolvePackageInvokeRuntimeSurface({ callerKind: 'package' })).toBe(
		'package',
	)
	expect(
		resolvePackageInvokeRuntimeSurface({
			callerKind: 'package',
			parentRunRecord: { surface: 'job' },
		}),
	).toBe('job')
	expect(
		resolvePackageInvokeRuntimeSurface({
			callerKind: 'package',
			runtimeSurface: 'app',
		}),
	).toBe('app')
})
