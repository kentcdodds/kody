import { expect, test } from 'vitest'
import { buildPackageServiceStorageId } from './package-service.ts'

test('buildPackageServiceStorageId creates stable per-service storage ids', () => {
	expect(buildPackageServiceStorageId('package-1', 'discord-gateway')).toBe(
		'service:package-1:discord-gateway',
	)
	expect(buildPackageServiceStorageId('package-1', 'guild sync')).toBe(
		'service:package-1:guild%20sync',
	)
	expect(buildPackageServiceStorageId('package-1', 'a:b/c')).toBe(
		'service:package-1:a%3Ab%2Fc',
	)
})

test('package service runtime source clears stale in-flight state on restore', async () => {
	const source = await import('./package-service.ts')
	const fileText = await import('node:fs/promises').then((fs) =>
		fs.readFile(new URL('./package-service.ts', import.meta.url), 'utf8'),
	)
	expect(fileText).toContain("this.stateSnapshot.status === 'running'")
	expect(fileText).toContain("this.stateSnapshot.status === 'stopping'")
	expect(fileText).toContain("this.stateSnapshot.status = 'stopped'")
	expect(fileText).toContain('this.stateSnapshot.currentRunId = null')
	expect(fileText).toContain('this.stateSnapshot.stopRequested = false')
	expect(source.buildPackageServiceStorageId).toBeTypeOf('function')
})

test('package service runtime preserves explicit stop requests after a run ends', async () => {
	const fileText = await import('node:fs/promises').then((fs) =>
		fs.readFile(new URL('./package-service.ts', import.meta.url), 'utf8'),
	)
	expect(fileText).toContain(
		'const stopRequested = this.stateSnapshot.stopRequested',
	)
	expect(fileText).toContain(
		"this.stateSnapshot.status = this.stateSnapshot.stopRequested\n\t\t\t\t? 'stopped'\n\t\t\t\t: 'error'",
	)
	expect(fileText).toContain("if (stopRequested) {\n\t\t\t\tawait this.clearAlarm()")
	expect(fileText).toContain('!this.stateSnapshot.stopRequested')
})

test('package service runtime refreshes manifest-backed service settings for alarms and status', async () => {
	const fileText = await import('node:fs/promises').then((fs) =>
		fs.readFile(new URL('./package-service.ts', import.meta.url), 'utf8'),
	)
	expect(fileText).toContain('const loaded = await loadSavedPackageService({')
	expect(fileText).toContain('this.stateSnapshot.binding = loaded.resolvedBinding')
	expect(fileText).toContain(
		'this.stateSnapshot.timeoutMs = loaded.serviceDefinition?.timeoutMs ?? null',
	)
	expect(fileText).toContain(
		'return Response.json(this.buildServiceStatusResponse(loaded.resolvedBinding))',
	)
	expect(fileText).toContain(
		'if (!this.stateSnapshot.stopRequested) {\n\t\t\t\tawait this.handleStartRequest({ binding: loaded.resolvedBinding })',
	)
})
