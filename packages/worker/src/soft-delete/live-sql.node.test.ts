import { expect, test } from 'vitest'
import {
	andLiveDeletedAtSql,
	liveDeletedAtSql,
	withLiveDeletedAt,
} from './live-sql.ts'

test('liveDeletedAtSql without alias', () => {
	expect(liveDeletedAtSql()).toBe('deleted_at IS NULL')
})

test('liveDeletedAtSql with alias', () => {
	expect(liveDeletedAtSql('o')).toBe('o.deleted_at IS NULL')
})

test('andLiveDeletedAtSql prefixes AND', () => {
	expect(andLiveDeletedAtSql('m')).toBe(' AND m.deleted_at IS NULL')
})

test('withLiveDeletedAt merges WHERE fragments', () => {
	expect(withLiveDeletedAt('id = ?', 'o')).toBe(
		'id = ? AND o.deleted_at IS NULL',
	)
	expect(withLiveDeletedAt('', 'o')).toBe('o.deleted_at IS NULL')
})
