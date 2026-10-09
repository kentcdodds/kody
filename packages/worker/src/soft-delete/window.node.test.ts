import { expect, test } from 'vitest'
import {
	isWithinSoftDeleteRestoreWindow,
	softDeletePurgeCutoffIso,
	softDeleteRetentionDays,
} from './window.ts'

test('softDeleteRetentionDays is thirty', () => {
	expect(softDeleteRetentionDays).toBe(30)
})

test('softDeletePurgeCutoffIso is UTC ISO thirty days before now', () => {
	const now = new Date('2026-10-09T12:00:00.000Z')
	expect(softDeletePurgeCutoffIso(now)).toBe('2026-09-09T12:00:00.000Z')
})

test('isWithinSoftDeleteRestoreWindow respects retention window', () => {
	const now = new Date('2026-10-09T12:00:00.000Z')
	const recent = '2026-10-01T12:00:00.000Z'
	const stale = '2026-08-01T12:00:00.000Z'
	expect(isWithinSoftDeleteRestoreWindow(recent, now)).toBe(true)
	expect(isWithinSoftDeleteRestoreWindow(stale, now)).toBe(false)
	expect(isWithinSoftDeleteRestoreWindow('not-a-date', now)).toBe(false)
})
