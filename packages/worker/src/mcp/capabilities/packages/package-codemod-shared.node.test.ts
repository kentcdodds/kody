import { expect, test } from 'vitest'
import { createPackageCodemodNextStep } from './package-codemod-shared.ts'

test('createPackageCodemodNextStep tells callers how to continue a page', () => {
	const apply = createPackageCodemodNextStep({
		runId: 'run-apply-1',
		nextCursor: 'cursor-2',
		mode: 'apply',
	})
	expect(apply).toContain('run-apply-1')
	expect(apply).toContain('cursor-2')

	const scan = createPackageCodemodNextStep({
		runId: 'run-scan-1',
		nextCursor: 'cursor-2',
		mode: 'scan',
	})
	expect(scan).toContain('run-scan-1')
	expect(scan).toContain('cursor-2')
	expect(scan).not.toBe(apply)

	const done = createPackageCodemodNextStep({
		runId: 'run-apply-1',
		nextCursor: null,
		mode: 'apply',
	})
	expect(done).not.toContain('cursor-2')
	expect(done).not.toContain('run-apply-1')
})
