import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import {
	classifyPackageInvokeSpecifierForm,
	recordPackageInvokeSpecifierForm,
	resolvePackageInvokeTelemetrySurface,
} from './specifier-form-telemetry.ts'
import {
	createExecutePackageInvokeToolsWithToolFactories,
	createPackageRuntimeInvokeToolsWithToolFactories,
} from './runtime-tool-factories.ts'

test('classifies raw forms before canonicalization and attributes every runtime surface', () => {
	expect(
		classifyPackageInvokeSpecifierForm(' kody:@owner/package/export '),
	).toBe('kody_prefixed')
	expect(classifyPackageInvokeSpecifierForm(' @owner/package/export ')).toBe(
		'prefixless',
	)
	expect(classifyPackageInvokeSpecifierForm('owner/package')).toBeNull()
	expect(classifyPackageInvokeSpecifierForm('kody:not-a-package')).toBeNull()
	expect(classifyPackageInvokeSpecifierForm('@owner / package/export')).toBe(
		'prefixless',
	)
	expect(
		classifyPackageInvokeSpecifierForm('kody:@owner / package/export'),
	).toBe('kody_prefixed')
	expect(classifyPackageInvokeSpecifierForm('@malformed attempt')).toBe(
		'prefixless',
	)
	expect(classifyPackageInvokeSpecifierForm('kody:@malformed attempt')).toBe(
		'kody_prefixed',
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
		indexes: ['prefixless'],
		blobs: ['prefixless', 'job'],
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

test('runtime helpers record raw prefixless forms for execute, package, job, and app before canonicalization', async () => {
	const writeDataPoint = vi.fn()
	const sharedInput = {
		env: {
			PACKAGE_INVOKE_SPECIFIER_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
		} as Env,
		baseUrl: 'https://example.test',
		callerContext: {
			user: { userId: 'private-user' },
		} as never,
		toolFactories: {} as never,
	}
	const packageContext = {
		packageId: 'private-package-id',
		kodyId: 'private-kody-id',
	}
	const toolsBySurface = [
		{
			surface: 'execute',
			tools: createExecutePackageInvokeToolsWithToolFactories(sharedInput),
		},
		{
			surface: 'package',
			tools: createPackageRuntimeInvokeToolsWithToolFactories({
				...sharedInput,
				packageContext,
			}),
		},
		{
			surface: 'job',
			tools: createExecutePackageInvokeToolsWithToolFactories({
				...sharedInput,
				parentRunRecord: { surface: 'job', name: 'private-job-name' },
			}),
		},
		{
			surface: 'app',
			tools: createPackageRuntimeInvokeToolsWithToolFactories({
				...sharedInput,
				packageContext,
				runtimeSurface: 'app',
			}),
		},
	] as const

	for (const { surface, tools } of toolsBySurface) {
		await expect(
			tools.invoke({
				specifier: '@private-owner/private-package',
				options: {},
			}),
		).rejects.toThrow(
			'packages.invoke requires exportName when the package specifier has no export subpath.',
		)
		expect(writeDataPoint).toHaveBeenLastCalledWith({
			indexes: ['prefixless'],
			blobs: ['prefixless', surface],
			doubles: [1],
		})
	}
	expect(writeDataPoint).toHaveBeenCalledTimes(4)
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('private')
})
