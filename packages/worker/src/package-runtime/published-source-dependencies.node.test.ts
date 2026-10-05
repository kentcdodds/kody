import { expect, test } from 'vitest'
import {
	isPublishedSourceWithinNpmBundleRebuildWindow,
	publishedNpmBundleRebuildWindowMs,
} from './published-source-dependencies.ts'

test('npm rebuild window uses publishedAt and ignores missing timestamps', () => {
	const nowMs = Date.parse('2026-10-05T00:04:00.000Z')
	expect(
		isPublishedSourceWithinNpmBundleRebuildWindow({
			publishedAt: '2026-10-05T00:03:00.000Z',
			nowMs,
		}),
	).toBe(true)
	expect(
		isPublishedSourceWithinNpmBundleRebuildWindow({
			publishedAt: new Date(
				nowMs - publishedNpmBundleRebuildWindowMs - 1,
			).toISOString(),
			nowMs,
		}),
	).toBe(false)
	expect(
		isPublishedSourceWithinNpmBundleRebuildWindow({
			publishedAt: null,
			nowMs,
		}),
	).toBe(false)
})
