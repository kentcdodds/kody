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
	const cases: Array<[Error, boolean]> = [
		[
			new Error('apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3847'),
			true,
		],
		[
			new Error(
				'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3847/',
			),
			true,
		],
		[
			Object.assign(new Error('fetch failed'), {
				cause: Object.assign(new Error('connect ECONNREFUSED'), {
					code: 'ECONNREFUSED',
				}),
			}),
			true,
		],
		[new Error('timeout of 15000ms'), false],
	]
	expect(cases.map(([error]) => isE2eWebServerConnectionError(error))).toEqual(
		cases.map(([, expected]) => expected),
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
	const results = [
		[
			'failed',
			'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3847/',
		],
		['passed', null],
		['failed', 'expect(locator).toHaveText failed'],
	].map(([status, message]) => {
		const result = {
			status: status!,
			errors: message ? [{ message }] : [],
			annotations: [],
		}
		attachUnreadCloneTeeHintIfNeeded(result)
		return result.annotations
	})
	expect(results).toEqual([
		[{ type: 'warning', description: e2eUnreadRequestCloneTeeRemediation }],
		[],
		[],
	])
})

test('assertE2eWebServerAlive fails fast once marked dead without fetching', async () => {
	expect(() => markE2eWebServerDead('http://127.0.0.1:3847', 'seed')).toThrow(
		E2eWebServerDeadError,
	)
	await expect(
		assertE2eWebServerAlive('http://127.0.0.1:3847'),
	).rejects.toBeInstanceOf(E2eWebServerDeadError)
})
