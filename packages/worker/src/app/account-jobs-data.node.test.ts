import { expect, test } from 'vitest'
import { jobOwnershipForId, packageIdFromJobId } from './account-jobs-data.ts'

test('packageIdFromJobId parses package-owned job ids', () => {
	expect(packageIdFromJobId('job-adhoc-1')).toBeNull()
	expect(packageIdFromJobId('package-job:')).toBeNull()
	expect(packageIdFromJobId('package-job:pkg-only')).toBeNull()
	expect(packageIdFromJobId('package-job::nightly')).toBeNull()
	expect(packageIdFromJobId('package-job:pkg-1:nightly')).toBe('pkg-1')
	expect(
		packageIdFromJobId(
			`package-job:b2fda105-005a-4e2b-9f22-1513b6752da2:${encodeURIComponent('state store')}`,
		),
	).toBe('b2fda105-005a-4e2b-9f22-1513b6752da2')
	expect(jobOwnershipForId('package-job:pkg-1:nightly')).toBe('package')
	expect(jobOwnershipForId('job-adhoc-1')).toBe('ad-hoc')
})
