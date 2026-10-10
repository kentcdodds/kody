import { expect, test } from 'vitest'
import {
	admitExecuteCallInWindows,
	ExecuteRepeatWindow,
} from './execute-admission-windows.ts'

const windowMs = 60_000

test('the repeat window admits up to the limit per rolling window, then reopens as the oldest call ages out', () => {
	const window = new ExecuteRepeatWindow()
	const start = 1_000_000
	for (let index = 0; index < 3; index += 1) {
		expect(
			window.admit({
				key: 'a',
				nowMs: start + index * 1_000,
				limit: 3,
				windowMs,
			}),
		).toEqual({ admitted: true, repeats: index + 1 })
	}
	expect(
		window.admit({ key: 'a', nowMs: start + 5_000, limit: 3, windowMs }),
	).toEqual({ admitted: false, repeats: 3, retryAfterMs: 55_000 })
	expect(
		window.admit({ key: 'b', nowMs: start + 5_000, limit: 3, windowMs }),
	).toEqual({ admitted: true, repeats: 1 })
	expect(
		window.admit({ key: 'a', nowMs: start + windowMs, limit: 3, windowMs }),
	).toEqual({ admitted: true, repeats: 3 })
})

test('the repeat window forgets the least recently admitted key past its key bound', () => {
	const window = new ExecuteRepeatWindow(2)
	window.admit({ key: 'a', nowMs: 1, limit: 1, windowMs })
	window.admit({ key: 'b', nowMs: 2, limit: 1, windowMs })
	window.admit({ key: 'c', nowMs: 3, limit: 1, windowMs })
	expect(
		window.admit({ key: 'a', nowMs: 4, limit: 1, windowMs }).admitted,
	).toBe(true)
	expect(
		window.admit({ key: 'c', nowMs: 5, limit: 1, windowMs }).admitted,
	).toBe(false)
})

test('a refused retry does not keep its key from being evicted first', () => {
	const window = new ExecuteRepeatWindow(2)
	window.admit({ key: 'a', nowMs: 1, limit: 1, windowMs })
	window.admit({ key: 'b', nowMs: 2, limit: 1, windowMs })
	expect(
		window.admit({ key: 'a', nowMs: 3, limit: 1, windowMs }).admitted,
	).toBe(false)
	window.admit({ key: 'c', nowMs: 4, limit: 1, windowMs })
	expect(
		window.admit({ key: 'b', nowMs: 5, limit: 1, windowMs }).admitted,
	).toBe(false)
	expect(
		window.admit({ key: 'a', nowMs: 6, limit: 1, windowMs }).admitted,
	).toBe(true)
})

test('admission refuses repeats without spending the per-minute count, and the rate limit wins over repeats', () => {
	const minuteWindow = { minute: 0, count: 0 }
	const repeatWindow = new ExecuteRepeatWindow()
	const nowMs = 120_000
	const repeat = { key: 'same', limit: 2, windowMs }
	const admit = () =>
		admitExecuteCallInWindows({
			nowMs,
			limitPerMinute: 3,
			repeat,
			minuteWindow,
			repeatWindow,
		})
	expect(admit()).toEqual({ admitted: true, count: 1 })
	expect(admit()).toEqual({ admitted: true, count: 2 })
	expect(admit()).toEqual({
		admitted: false,
		reason: 'repeat',
		repeats: 2,
		retryAfterMs: windowMs,
	})
	expect(minuteWindow.count).toBe(2)
	expect(
		admitExecuteCallInWindows({
			nowMs,
			limitPerMinute: 3,
			minuteWindow,
			repeatWindow,
		}),
	).toEqual({ admitted: true, count: 3 })
	expect(admit()).toEqual({
		admitted: false,
		reason: 'rate',
		count: 3,
		retryAfterMs: 60_000,
	})
})
