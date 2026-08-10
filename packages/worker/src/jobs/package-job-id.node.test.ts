import { expect, test } from 'vitest'
import { buildPackageJobId, packageIdFromJobId } from './package-job-id.ts'

test('package job ids round-trip their package id and reject malformed ids', () => {
	const packageId = '11c7ff51-aa34-4ab8-94d6-bdd5e6af6d40'
	const jobId = buildPackageJobId(packageId, 'archive sync: daily')

	expect(jobId).toBe(
		'package-job:11c7ff51-aa34-4ab8-94d6-bdd5e6af6d40:archive%20sync%3A%20daily',
	)
	expect(packageIdFromJobId(jobId)).toBe(packageId)
	expect(packageIdFromJobId('job:standalone')).toBeNull()
	expect(packageIdFromJobId('package-job::missing-package')).toBeNull()
	expect(packageIdFromJobId('package-job:missing-name')).toBeNull()
})
