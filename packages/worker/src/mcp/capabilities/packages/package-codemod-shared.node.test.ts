import { expect, test } from 'vitest'
import { createPackageCodemodNextStep } from './package-codemod-shared.ts'

test('createPackageCodemodNextStep tells callers how to continue a page', () => {
	expect(
		createPackageCodemodNextStep({
			runId: 'run-apply-1',
			nextCursor: 'cursor-2',
			mode: 'apply',
		}),
	).toBe(
		'This page is done. Continue in a new execute or workflows.create call with runId run-apply-1 and cursor cursor-2 (limit ≤5). Do not page again in the same sandbox.',
	)
	expect(
		createPackageCodemodNextStep({
			runId: 'run-dry-1',
			nextCursor: 'cursor-3',
			mode: 'dry-run',
		}),
	).toBe(
		'This page is done. Continue in a new execute or workflows.create call with runId run-dry-1 and cursor cursor-3 (limit ≤5). Do not page again in the same sandbox.',
	)
	expect(
		createPackageCodemodNextStep({
			runId: 'run-revert-1',
			nextCursor: 'cursor-4',
			mode: 'revert',
		}),
	).toBe(
		'This page is done. Continue in a new execute or workflows.create call with runId run-revert-1 and cursor cursor-4 (limit ≤5). Do not page again in the same sandbox.',
	)
	expect(
		createPackageCodemodNextStep({
			runId: 'run-scan-1',
			nextCursor: 'cursor-2',
			mode: 'scan',
		}),
	).toBe(
		'Continue with runId run-scan-1 and cursor cursor-2. Scan pages usually fit in one sandbox; spawn a new workflow if the call is approaching the sandbox budget.',
	)
	expect(
		createPackageCodemodNextStep({
			runId: 'run-apply-1',
			nextCursor: null,
			mode: 'apply',
		}),
	).toBe('This run has no further pages.')
})
