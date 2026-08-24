import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { packageInvokePrefixlessEvidenceEpoch } from '#universal/package-invoke-prefixless-evidence.ts'
import {
	classifyPackageInvokeSpecifierForm,
	packageInvokeSpecifierTelemetryIndex,
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

test('runtime helpers record exact prefixless evidence for every valid runtime surface before canonicalization', async () => {
	const writeDataPoint = vi.fn()
	const recordPackageInvokePrefixless = vi.fn(async () => ({ recorded: true }))
	const sharedInput = {
		env: {
			PACKAGE_INVOKE_SPECIFIER_EVENTS: {
				writeDataPoint,
			} as unknown as AnalyticsEngineDataset,
			USER_METER: {
				idFromName: (name: string) => ({ name }),
				get: () => ({ recordPackageInvokePrefixless }),
			} as unknown as DurableObjectNamespace,
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
				specifier: '@private-owner/private-package/private-export',
				options: {},
			}),
		).rejects.toBeInstanceOf(Error)
		expect(writeDataPoint).toHaveBeenLastCalledWith({
			indexes: [packageInvokeSpecifierTelemetryIndex],
			blobs: ['prefixless', surface],
			doubles: [1],
		})
	}
	expect(writeDataPoint).toHaveBeenCalledTimes(4)
	expect(recordPackageInvokePrefixless).toHaveBeenCalledTimes(4)
	expect(
		recordPackageInvokePrefixless.mock.calls.map(([input]) => input),
	).toEqual(
		toolsBySurface.map(({ surface }) => ({
			epoch: packageInvokePrefixlessEvidenceEpoch,
			surface,
		})),
	)
	expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('private')
	expect(
		JSON.stringify(recordPackageInvokePrefixless.mock.calls),
	).not.toContain('private')
})

test('prefixed calls add no UserMeter RPC and prefixless evidence failure is fail-closed without retry', async () => {
	const recordPackageInvokePrefixless = vi
		.fn()
		.mockRejectedValue(new Error('meter unavailable'))
	const tools = createExecutePackageInvokeToolsWithToolFactories({
		env: {
			USER_METER: {
				idFromName: (name: string) => ({ name }),
				get: () => ({ recordPackageInvokePrefixless }),
			} as unknown as DurableObjectNamespace,
		} as Env,
		baseUrl: 'https://example.test',
		callerContext: {
			user: { userId: 'private-user' },
		} as never,
		toolFactories: {} as never,
	})

	await expect(
		tools.invoke({
			specifier: 'kody:@owner/package/export',
			options: {},
		}),
	).rejects.toBeInstanceOf(Error)
	expect(recordPackageInvokePrefixless).not.toHaveBeenCalled()

	await expect(
		tools.invoke({
			specifier: '@owner/package/export',
			options: {},
		}),
	).rejects.toThrow('could not record exact migration evidence')
	expect(recordPackageInvokePrefixless).toHaveBeenCalledExactlyOnceWith({
		epoch: packageInvokePrefixlessEvidenceEpoch,
		surface: 'execute',
	})

	recordPackageInvokePrefixless.mockReset()
	const controller = new AbortController()
	recordPackageInvokePrefixless.mockImplementation(async () => {
		controller.abort(new Error('cancelled after evidence'))
		return { recorded: true }
	})
	await expect(
		tools.invoke(
			{
				specifier: '@owner/package/export',
				options: {},
			},
			controller.signal,
		),
	).rejects.toThrow('cancelled after evidence')
	expect(recordPackageInvokePrefixless).toHaveBeenCalledTimes(1)
})
