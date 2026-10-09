import { expect, test } from 'vitest'
import { readFlags, readTokenLifetime } from './run.ts'

test('readFlags pairs flags with values and rejects bare or flag-shaped values', () => {
	expect(readFlags(['--worker', 'kody-branch-x', '--out', 'a.json'])).toEqual(
		new Map([
			['worker', 'kody-branch-x'],
			['out', 'a.json'],
		]),
	)
	expect(() => readFlags(['--worker'])).toThrow('Missing value for --worker')
	expect(() => readFlags(['--worker', '--out'])).toThrow(
		'Missing value for --worker',
	)
	expect(() => readFlags(['seed'])).toThrow('Unexpected argument "seed"')
})

test('readTokenLifetime requires an explicit lifetime', () => {
	expect(readTokenLifetime(new Map([['lifetime', 'short']]))).toEqual({
		lifetime: 'short',
	})
	expect(
		readTokenLifetime(
			new Map([
				['idle-ttl-seconds', '3600'],
				['max-lifetime-seconds', '86400'],
			]),
		),
	).toEqual({ idle_ttl_seconds: 3600, max_lifetime_seconds: 86400 })
	expect(() => readTokenLifetime(new Map())).toThrow(
		'An explicit token lifetime is required',
	)
	const invalid: Array<[idle: string, max: string]> = [
		['', ''],
		['0', '86400'],
		['3600', '-1'],
		['1.5', '86400'],
	]
	for (const [idle, max] of invalid) {
		expect(() =>
			readTokenLifetime(
				new Map([
					['idle-ttl-seconds', idle],
					['max-lifetime-seconds', max],
				]),
			),
		).toThrow('An explicit token lifetime is required')
	}
	expect(() => readTokenLifetime(new Map([['lifetime', 'forever']]))).toThrow(
		'--lifetime must be short or long',
	)
	expect(() =>
		readTokenLifetime(
			new Map([
				['lifetime', 'short'],
				['idle-ttl-seconds', '60'],
			]),
		),
	).toThrow('not both')
})
