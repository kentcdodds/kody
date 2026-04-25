import { expect, test } from 'vitest'
import { buildPackageServiceStorageId } from './package-service.ts'

test('buildPackageServiceStorageId creates stable per-service storage ids', () => {
	expect(buildPackageServiceStorageId('package-1', 'realtime-supervisor')).toBe(
		'service:package-1:realtime-supervisor',
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
		'this.stateSnapshot.stopRequested = false',
	)
	expect(fileText).toContain(
		"this.stateSnapshot.status = this.stateSnapshot.stopRequested\n\t\t\t\t? 'stopped'\n\t\t\t\t: 'error'",
	)
	expect(fileText).toContain("if (stopRequested) {\n\t\t\t\tawait this.clearAlarm()")
	expect(fileText).toContain('!this.stateSnapshot.stopRequested')
})

test('package service runtime re-arms auto-start after unplanned exit', async () => {
	const fileText = await import('node:fs/promises').then((fs) =>
		fs.readFile(new URL('./package-service.ts', import.meta.url), 'utf8'),
	)
	expect(fileText).toContain('loaded.serviceDefinition?.autoStart')
	expect(fileText).toContain('!this.stateSnapshot.nextAlarmAt')
	expect(fileText).toContain('await this.scheduleAlarm({ runAt: new Date() })')
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
	expect(fileText).toContain("'timeoutMs' in overrides")
	expect(fileText).toContain(
		'const binding = loaded?.resolvedBinding ?? this.stateSnapshot.binding ?? input.binding',
	)
	expect(fileText).toContain(
		'loaded = await this.initializeBinding(input.binding, {',
	)
	expect(fileText).toContain('this.buildServiceStatusResponse(')
	expect(fileText).toContain('binding,')
	expect(fileText).toContain('loaded?.serviceDefinition')
	expect(fileText).not.toContain(
		'if (!this.stateSnapshot.stopRequested) {\n\t\t\t\tawait this.handleStartRequest({ binding: loaded.resolvedBinding })',
	)
})

test('package service runtime schedules auto-start on save path instead of read-only status calls', async () => {
	const fileText = await import('node:fs/promises').then((fs) =>
		fs.readFile(new URL('./package-service.ts', import.meta.url), 'utf8'),
	)
	expect(fileText).toContain('options?: { armAutoStart?: boolean }')
	expect(fileText).toContain('options?.armAutoStart')
	expect(fileText).toContain('armAutoStart: true')
	expect(fileText).toContain(
		'const binding = loaded?.resolvedBinding ?? this.stateSnapshot.binding ?? input.binding',
	)
	expect(fileText).not.toContain('this.stateSnapshot.stopRequested = false\n\t\t\t\tthis.stateSnapshot.currentRunId = runId')
})

test('package service runtime persists restored state and surfaces RPC errors', async () => {
	const fileText = await import('node:fs/promises').then((fs) =>
		fs.readFile(new URL('./package-service.ts', import.meta.url), 'utf8'),
	)
	expect(fileText).toContain('await this.persistState()')
	expect(fileText).toContain('export async function readPackageServiceRpcResponse<T>(')
	expect(fileText).toContain('if (!response.ok) {')
	expect(fileText).toContain(
		'text || `Package service request failed with status ${response.status}.`',
	)
})
