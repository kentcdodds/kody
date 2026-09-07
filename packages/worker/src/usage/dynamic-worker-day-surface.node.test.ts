import { expect, test } from 'vitest'
import { runSurfaceValues } from '#worker/run-records/types.ts'
import {
	dynamicWorkerDaySurfaceFromRunSurface,
	dynamicWorkerDaySurfaces,
	isDynamicWorkerDaySurface,
	resolveDynamicWorkerDaySurface,
} from './dynamic-worker-day-surface.ts'

test('every run surface maps to a documented UWD surface', () => {
	expect(dynamicWorkerDaySurfaceFromRunSurface('execute')).toBe('execute')
	expect(dynamicWorkerDaySurfaceFromRunSurface('export')).toBe('package_export')
	expect(dynamicWorkerDaySurfaceFromRunSurface('job')).toBe('job')
	expect(dynamicWorkerDaySurfaceFromRunSurface('workflow')).toBe('workflow')
	expect(dynamicWorkerDaySurfaceFromRunSurface('subscription')).toBe(
		'subscription',
	)
	expect(dynamicWorkerDaySurfaceFromRunSurface('app_fetch')).toBe('app_fetch')
	expect(dynamicWorkerDaySurfaceFromRunSurface('app_realtime')).toBe(
		'app_realtime',
	)
	expect(dynamicWorkerDaySurfaceFromRunSurface('retriever')).toBe('retriever')
	expect(dynamicWorkerDaySurfaceFromRunSurface('webhook')).toBe('webhook')
	expect(dynamicWorkerDaySurfaceFromRunSurface(null)).toBe('unknown')
	expect(dynamicWorkerDaySurfaceFromRunSurface(undefined)).toBe('unknown')

	for (const surface of runSurfaceValues) {
		const mapped = dynamicWorkerDaySurfaceFromRunSurface(surface)
		expect(isDynamicWorkerDaySurface(mapped)).toBe(true)
		expect(mapped).not.toBe('unknown')
	}
})

test('resolveDynamicWorkerDaySurface infers package_export only when the run surface is missing', () => {
	expect(
		resolveDynamicWorkerDaySurface({
			surface: 'job',
			hasPackageContext: true,
		}),
	).toBe('job')
	expect(
		resolveDynamicWorkerDaySurface({
			surface: null,
			hasPackageContext: true,
		}),
	).toBe('package_export')
	expect(
		resolveDynamicWorkerDaySurface({
			hasPackageContext: false,
		}),
	).toBe('execute')
	expect(dynamicWorkerDaySurfaces).toContain('unknown')
})
