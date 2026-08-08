import { afterEach, expect, test } from 'vitest'
import {
	E2eWebServerDeadError,
	assertE2eWebServerAlive,
	isE2eWebServerConnectionError,
	isE2eWebServerMarkedDead,
	markE2eWebServerDead,
	resetE2eWebServerLivenessForTests,
	throwIfE2eWebServerDead,
} from './web-server-liveness.ts'

afterEach(() => {
	resetE2eWebServerLivenessForTests()
})

test('isE2eWebServerConnectionError matches Playwright and Node refused forms', () => {
	expect(
		isE2eWebServerConnectionError(
			new Error('apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3847'),
		),
	).toBe(true)
	expect(
		isE2eWebServerConnectionError(
			new Error(
				'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3847/',
			),
		),
	).toBe(true)
	expect(
		isE2eWebServerConnectionError(
			Object.assign(new Error('fetch failed'), {
				cause: Object.assign(new Error('connect ECONNREFUSED'), {
					code: 'ECONNREFUSED',
				}),
			}),
		),
	).toBe(true)
	expect(isE2eWebServerConnectionError(new Error('timeout of 15000ms'))).toBe(
		false,
	)
})

test('throwIfE2eWebServerDead latches and upgrades connection errors', () => {
	expect(() =>
		throwIfE2eWebServerDead(
			new Error('connect ECONNREFUSED 127.0.0.1:3847'),
			'http://127.0.0.1:3847',
		),
	).toThrow(E2eWebServerDeadError)
	expect(isE2eWebServerMarkedDead()).toBe(true)
	expect(() =>
		throwIfE2eWebServerDead(new Error('unrelated'), 'http://127.0.0.1:3847'),
	).toThrow(E2eWebServerDeadError)
})

test('assertE2eWebServerAlive fails fast once marked dead without fetching', async () => {
	expect(() => markE2eWebServerDead('http://127.0.0.1:3847', 'seed')).toThrow(
		E2eWebServerDeadError,
	)
	await expect(
		assertE2eWebServerAlive('http://127.0.0.1:3847'),
	).rejects.toBeInstanceOf(E2eWebServerDeadError)
})
