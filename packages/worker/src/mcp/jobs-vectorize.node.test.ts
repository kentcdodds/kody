import { expect, test } from 'vitest'

import { jobVectorId } from './jobs-vectorize.ts'

const vectorizeMaxIdBytes = 64
const textEncoder = new TextEncoder()

function getUtf8ByteLength(value: string) {
	return textEncoder.encode(value).byteLength
}

test('jobVectorId preserves existing ids that fit Vectorize limits', () => {
	expect(jobVectorId('job-1')).toBe('job_job-1')
})

test('jobVectorId shortens package job ids that exceed Vectorize limits', () => {
	const packageJobId =
		'package-job:b2fda105-005a-4e2b-9f22-1513b6752da2:event-runner'

	const vectorId = jobVectorId(packageJobId)

	expect(vectorId).toMatch(/^job_[0-9a-z]+$/)
	expect(getUtf8ByteLength(vectorId)).toBeLessThanOrEqual(vectorizeMaxIdBytes)
	expect(jobVectorId(packageJobId)).toBe(vectorId)
})
