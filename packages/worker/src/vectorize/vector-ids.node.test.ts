import { expect, test } from 'vitest'
import {
	buildLengthSafeVectorId,
	getRawIdFromPassthroughVectorId,
	vectorizeMaxIdBytes,
} from './vector-ids.ts'

const textEncoder = new TextEncoder()

function byteLength(value: string) {
	return textEncoder.encode(value).length
}

test('buildLengthSafeVectorId preserves ids at or below the Vectorize limit', () => {
	const rawId = 'a'.repeat(60)
	const vectorId = buildLengthSafeVectorId({ prefix: 'job', rawId })

	expect(vectorId).toBe(`job_${rawId}`)
	expect(byteLength(vectorId)).toBe(vectorizeMaxIdBytes)
})

test('buildLengthSafeVectorId uses a deterministic digest above the limit', () => {
	expect(
		buildLengthSafeVectorId({ prefix: 'job', rawId: 'a'.repeat(61) }),
	).toBe('job_sha256:35d5fc17cfbbadd00f5e710ada39f194c5ad7c766ad67072245f1')

	const rawId = 'package-job:b2fda105-005a-4e2b-9f22-1513b6752da2:event-runner'
	const firstVectorId = buildLengthSafeVectorId({ prefix: 'job', rawId })
	const secondVectorId = buildLengthSafeVectorId({ prefix: 'job', rawId })
	const differentVectorId = buildLengthSafeVectorId({
		prefix: 'job',
		rawId: `${rawId}-2`,
	})

	expect(byteLength(`job_${rawId}`)).toBeGreaterThan(vectorizeMaxIdBytes)
	expect(firstVectorId).toBe(secondVectorId)
	expect(firstVectorId).not.toBe(differentVectorId)
	expect(firstVectorId).toMatch(/^job_sha256:[0-9a-f]+$/)
	expect(byteLength(firstVectorId)).toBeLessThanOrEqual(vectorizeMaxIdBytes)
})

test('buildLengthSafeVectorId checks UTF-8 bytes instead of string length', () => {
	const rawId = '界'.repeat(20)
	const passthrough = `memory_${rawId}`
	const vectorId = buildLengthSafeVectorId({ prefix: 'memory', rawId })

	expect(passthrough.length).toBeLessThanOrEqual(vectorizeMaxIdBytes)
	expect(byteLength(passthrough)).toBeGreaterThan(vectorizeMaxIdBytes)
	expect(vectorId).toMatch(/^memory_sha256:[0-9a-f]+$/)
	expect(byteLength(vectorId)).toBeLessThanOrEqual(vectorizeMaxIdBytes)
})

test('getRawIdFromPassthroughVectorId only parses passthrough ids', () => {
	expect(
		getRawIdFromPassthroughVectorId({
			prefix: 'memory',
			vectorId: 'memory_mem-1',
		}),
	).toBe('mem-1')
	expect(
		getRawIdFromPassthroughVectorId({
			prefix: 'memory',
			vectorId:
				'memory_sha256:1b1856c0142a4f2d8993664f79b51e7fa4b8a431e3e1f2e542',
		}),
	).toBeNull()
	expect(
		getRawIdFromPassthroughVectorId({
			prefix: 'memory',
			vectorId: 'job_mem-1',
		}),
	).toBeNull()
})
