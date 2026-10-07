import { expect, test } from 'vitest'
import {
	canKeepPreviousNpmBundleDuringRebuild,
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

test('keep-previous treats a missing finalize clock as still in the rebuild window', () => {
	const nowMs = Date.parse('2026-10-05T00:04:00.000Z')
	expect(
		canKeepPreviousNpmBundleDuringRebuild({
			publishedAt: null,
			nowMs,
		}),
	).toBe(true)
	expect(
		canKeepPreviousNpmBundleDuringRebuild({
			publishedAt: undefined,
			nowMs,
		}),
	).toBe(true)
	expect(
		canKeepPreviousNpmBundleDuringRebuild({
			publishedAt: '',
			nowMs,
		}),
	).toBe(true)
	expect(
		canKeepPreviousNpmBundleDuringRebuild({
			publishedAt: '2026-10-05T00:03:00.000Z',
			nowMs,
		}),
	).toBe(true)
	expect(
		canKeepPreviousNpmBundleDuringRebuild({
			publishedAt: new Date(
				nowMs - publishedNpmBundleRebuildWindowMs - 1,
			).toISOString(),
			nowMs,
		}),
	).toBe(false)
})
