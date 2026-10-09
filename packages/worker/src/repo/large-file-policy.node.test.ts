import { expect, test } from 'vitest'
import {
	findOversizedRepoSourceFile,
	isRepoDiffTooLargeMessage,
	isRepoLargeFileMessage,
	maxRepoSourceFileBytes,
	maxRepoSourceFileDiffLines,
	measureRepoSourceFileBytes,
	measureRepoSourceFileLines,
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

	expect(isRepoLargeFileMessage('Source "x" was not found.')).toBe(false)
})

test('diff-line policy mirrors the Cloudflare shell ceiling and classifies stable plus raw EFBIG messages', () => {
	expect(measureRepoSourceFileLines('')).toBe(1)
	expect(measureRepoSourceFileLines('a')).toBe(1)
	expect(measureRepoSourceFileLines('a\nb')).toBe(2)
	expect(measureRepoSourceFileLines(`${'x\n'.repeat(10_000)}x`)).toBe(
		maxRepoSourceFileDiffLines + 1,
	)

	expect(
		isRepoDiffTooLargeMessage(
			'EFBIG: content too large for diff (max 10000 lines)',
		),
	).toBe(true)
	expect(
		isRepoDiffTooLargeMessage(
			'EFBIG: files too large for diff (max 10000 lines)',
		),
	).toBe(true)
	expect(
		isRepoDiffTooLargeMessage(
			'applyEdits failed: content too large for diff (max 10000 lines)',
		),
	).toBe(true)
	expect(isRepoDiffTooLargeMessage('EFBIG: stream exceeds maximum size')).toBe(
		false,
	)
	expect(isRepoDiffTooLargeMessage('Source "x" was not found.')).toBe(false)
	expect(
		isRepoLargeFileMessage(
			'EFBIG: content too large for diff (max 10000 lines)',
		),
	).toBe(false)
})
