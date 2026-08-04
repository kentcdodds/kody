import { expect, test } from 'vitest'
import {
	buildRepoLargeFileMessage,
	findOversizedRepoSourceFile,
	isRepoLargeFileMessage,
	maxRepoSourceFileBytes,
	measureRepoSourceFileBytes,
} from './large-file-policy.ts'

test('large-file policy measures UTF-8 bytes, finds the first oversize file, and classifies rejection messages', () => {
	expect(measureRepoSourceFileBytes('abc')).toBe(3)
	// U+1F600 encodes to 4 UTF-8 bytes but 2 UTF-16 code units.
	expect(measureRepoSourceFileBytes('😀')).toBe(4)

	const within = 'x'.repeat(maxRepoSourceFileBytes)
	const over = 'x'.repeat(maxRepoSourceFileBytes + 1)
	expect(
		findOversizedRepoSourceFile([
			['src/index.ts', 'export default async function main() {}\n'],
			['assets/ok.txt', within],
		]),
	).toBeNull()
	expect(
		findOversizedRepoSourceFile([
			['assets/ok.txt', within],
			['assets/too-big.txt', over],
		]),
	).toEqual({
		path: 'assets/too-big.txt',
		byteLength: maxRepoSourceFileBytes + 1,
	})

	const message = buildRepoLargeFileMessage({
		path: 'assets/too-big.txt',
		byteLength: maxRepoSourceFileBytes + 1,
	})
	expect(message).toContain('"assets/too-big.txt"')
	expect(isRepoLargeFileMessage(message)).toBe(true)
	expect(isRepoLargeFileMessage('Source "x" was not found.')).toBe(false)
})
