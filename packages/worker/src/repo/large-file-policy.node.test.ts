import { expect, test } from 'vitest'
import {
	buildRepoLargeFileMessage,
	findOversizedRepoSourceFile,
	maxRepoSourceFileBytes,
	measureRepoSourceFileBytes,
} from './large-file-policy.ts'

test('measureRepoSourceFileBytes counts UTF-8 bytes, not code units', () => {
	expect(measureRepoSourceFileBytes('abc')).toBe(3)
	// U+1F600 encodes to 4 UTF-8 bytes but 2 UTF-16 code units.
	expect(measureRepoSourceFileBytes('😀')).toBe(4)
})

test('findOversizedRepoSourceFile returns the first file over the limit', () => {
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
})

test('buildRepoLargeFileMessage names the file, sizes, and hosting guidance', () => {
	const message = buildRepoLargeFileMessage({
		path: 'assets/video-notes.md',
		byteLength: 12 * 1024 * 1024,
	})
	expect(message).toContain('"assets/video-notes.md"')
	expect(message).toContain('12.0 MiB')
	expect(message).toContain('10.0 MiB per-file limit')
	expect(message).toContain('Cloudflare R2')
	expect(message).toContain('link or pointer file')
})
