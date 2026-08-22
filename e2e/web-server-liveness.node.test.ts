import { afterEach, expect, test } from 'vitest'
import {
	E2eWebServerDeadError,
	assertE2eWebServerAlive,
	attachUnreadCloneTeeHintIfNeeded,
	e2eUnreadRequestCloneTeeRemediation,
	e2eWebServerDeadCode,
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

test('E2eWebServerDeadError names the unread clone tee fix', () => {
	let thrown: unknown
	try {
		markE2eWebServerDead('http://127.0.0.1:3847', 'seed')
	} catch (error) {
		thrown = error
	}
	expect(thrown).toBeInstanceOf(E2eWebServerDeadError)
	if (!(thrown instanceof E2eWebServerDeadError)) return
	expect(thrown.code).toBe(e2eWebServerDeadCode)
	expect(thrown.message).toContain('discardUnreadRequestBody')
	expect(thrown.message).toContain('#worker/request-body.ts')
	expect(thrown.message).toContain('request.clone()')
	expect(thrown.message).toContain(e2eUnreadRequestCloneTeeRemediation)
})

test('attachUnreadCloneTeeHintIfNeeded annotates connection-refused failures', () => {
	const refused = {
		status: 'failed',
		errors: [
			{
				message:
					'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3847/',
			},
		],
		annotations: [],
	}
	attachUnreadCloneTeeHintIfNeeded(refused)
	expect(refused.annotations).toEqual([
		{
			type: 'warning',
			description: e2eUnreadRequestCloneTeeRemediation,
		},
	])

	const passed = {
		status: 'passed',
		errors: [],
		annotations: [],
	}
	attachUnreadCloneTeeHintIfNeeded(passed)
	expect(passed.annotations).toEqual([])

	const unrelated = {
		status: 'failed',
		errors: [{ message: 'expect(locator).toHaveText failed' }],
		annotations: [],
	}
	attachUnreadCloneTeeHintIfNeeded(unrelated)
	expect(unrelated.annotations).toEqual([])
})

test('assertE2eWebServerAlive fails fast once marked dead without fetching', async () => {
	expect(() => markE2eWebServerDead('http://127.0.0.1:3847', 'seed')).toThrow(
		E2eWebServerDeadError,
	)
	await expect(
		assertE2eWebServerAlive('http://127.0.0.1:3847'),
	).rejects.toBeInstanceOf(E2eWebServerDeadError)
})
