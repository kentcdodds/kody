import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	classifyPackageInvokeSpecifierForm,
	packageInvokeSpecifierTelemetryIndex,
	recordPackageInvokeSpecifierForm,
	resolvePackageInvokeTelemetrySurface,
} from './specifier-form-telemetry.ts'

test('classifies raw forms before canonicalization and attributes every runtime surface', () => {
	expect(
		classifyPackageInvokeSpecifierForm(' kody:@owner/package/export '),
	).toBe('kody_prefixed')
	expect(classifyPackageInvokeSpecifierForm(' @owner/package/export ')).toBe(
		'prefixless',
	)
	expect(classifyPackageInvokeSpecifierForm('owner/package')).toBeNull()
	expect(classifyPackageInvokeSpecifierForm('@malformed attempt')).toBe(
		'prefixless',
	)

	expect(resolvePackageInvokeTelemetrySurface({ callerKind: 'execute' })).toBe(
		'execute',
	)
	expect(resolvePackageInvokeTelemetrySurface({ callerKind: 'package' })).toBe(
		'package',
	)
	expect(
		resolvePackageInvokeTelemetrySurface({
			callerKind: 'package',
			runtimeSurface: 'app',
		}),
	).toBe('app')
	expect(
		resolvePackageInvokeTelemetrySurface({
			callerKind: 'execute',
			runtimeSurface: 'app',
			parentRunRecord: { surface: 'job', name: 'private-name' },
		}),
	).toBe('job')
})

test('records a privacy-safe payload and never throws when unavailable or broken', () => {
	const writeDataPoint = vi.fn()
	recordPackageInvokeSpecifierForm(
		{
			PACKAGE_INVOKE_SPECIFIER_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			rawSpecifier: '@secret-owner/secret-package/private-export',
			surface: 'job',
		},
	)
	expect(writeDataPoint).toHaveBeenCalledExactlyOnceWith({
		indexes: [packageInvokeSpecifierTelemetryIndex],
		blobs: ['prefixless', 'job'],
		doubles: [1],
	})
	recordPackageInvokeSpecifierForm(
		{
			PACKAGE_INVOKE_SPECIFIER_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		},
		{
			rawSpecifier: 'kody:@owner/package/export',
			surface: 'execute',
		},
	)
	expect(writeDataPoint).toHaveBeenLastCalledWith({
		indexes: [packageInvokeSpecifierTelemetryIndex],
		blobs: ['kody_prefixed', 'execute'],
		doubles: [1],
	})
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('secret')

	expect(() =>
		recordPackageInvokeSpecifierForm(
			{},
			{ rawSpecifier: 'kody:@owner/package/export', surface: 'execute' },
		),
	).not.toThrow()

	consoleWarn.mockImplementation(() => {})
	expect(() =>
		recordPackageInvokeSpecifierForm(
			{
				PACKAGE_INVOKE_SPECIFIER_EVENTS: {
					writeDataPoint() {
						throw new Error('unavailable')
					},
				} as unknown as AnalyticsEngineDataset,
			},
			{ rawSpecifier: 'kody:@owner/package/export', surface: 'app' },
		),
	).not.toThrow()
	expect(consoleWarn).toHaveBeenCalledExactlyOnceWith(
		'package-invoke-specifier-event-failed',
		expect.any(Error),
	)
})
