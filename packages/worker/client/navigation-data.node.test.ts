import { expect, test } from 'vitest'
import { type AppLoaderData } from '#app/loader-data.ts'
import {
	clearPreloadedNavigationData,
	consumeStaleNavigationData,
	markNavigationDataStale,
	setPreloadedNavigationData,
	tryConsumePreloadedLoaderData,
} from './navigation-data.ts'

test('tryConsumePreloadedLoaderData returns data once for matching href', () => {
	clearPreloadedNavigationData()
	setPreloadedNavigationData('/account', {
		accountProfile: {
			ok: true,
			email: 'kody@example.com',
			username: 'kody',
			displayName: 'Kody',
		},
	})

	expect(tryConsumePreloadedLoaderData('accountProfile', '/account')).toEqual({
		ok: true,
		email: 'kody@example.com',
		username: 'kody',
		displayName: 'Kody',
	})
	expect(
		tryConsumePreloadedLoaderData('accountProfile', '/account'),
	).toBeUndefined()
})

test('tryConsumePreloadedLoaderData ignores mismatched href', () => {
	clearPreloadedNavigationData()
	setPreloadedNavigationData('/account', {
		accountProfile: {
			ok: true,
			email: 'kody@example.com',
			username: 'kody',
			displayName: 'Kody',
		},
	})

	expect(
		tryConsumePreloadedLoaderData('accountProfile', '/account/secrets'),
	).toBeUndefined()
	expect(tryConsumePreloadedLoaderData('accountProfile', '/account')).toEqual({
		ok: true,
		email: 'kody@example.com',
		username: 'kody',
		displayName: 'Kody',
	})
})

test('tryConsumePreloadedLoaderData normalizes href before matching', () => {
	clearPreloadedNavigationData()
	setPreloadedNavigationData('https://kody.local/account?q=1#top', {
		accountProfile: {
			ok: true,
			email: 'kody@example.com',
			username: 'kody',
			displayName: 'Kody',
		},
	})

	expect(
		tryConsumePreloadedLoaderData('accountProfile', '/account?q=1#top'),
	).toEqual({
		ok: true,
		email: 'kody@example.com',
		username: 'kody',
		displayName: 'Kody',
	})
})

test('setPreloadedNavigationData replaces the previous slot', () => {
	clearPreloadedNavigationData()
	setPreloadedNavigationData('/account', {
		accountProfile: {
			ok: true,
			email: 'first@example.com',
			username: 'first',
			displayName: 'First',
		},
	})
	setPreloadedNavigationData('/account', {
		accountProfile: {
			ok: true,
			email: 'second@example.com',
			username: 'second',
			displayName: 'Second',
		},
	})

	expect(tryConsumePreloadedLoaderData('accountProfile', '/account')).toEqual({
		ok: true,
		email: 'second@example.com',
		username: 'second',
		displayName: 'Second',
	})
})

test('tryConsumePreloadedLoaderData leaves unrelated keys until consumed', () => {
	clearPreloadedNavigationData()
	const payload: Partial<AppLoaderData> = {
		accountProfile: {
			ok: true,
			email: 'kody@example.com',
			username: 'kody',
			displayName: 'Kody',
		},
		adminUsers: {
			ok: true,
			users: [],
			page: 1,
			pageSize: 25,
			total: 0,
			availableRoles: [],
		},
	}
	setPreloadedNavigationData('/account', payload)

	expect(
		tryConsumePreloadedLoaderData('accountProfile', '/account'),
	).toBeTruthy()
	expect(tryConsumePreloadedLoaderData('adminUsers', '/account')).toBeTruthy()
	expect(
		tryConsumePreloadedLoaderData('adminUsers', '/account'),
	).toBeUndefined()
})

test('consumeStaleNavigationData is one-shot for the marked href', () => {
	clearPreloadedNavigationData()
	markNavigationDataStale('/account')

	expect(consumeStaleNavigationData('/account')).toBe(true)
	expect(consumeStaleNavigationData('/account')).toBe(false)
})

test('consumeStaleNavigationData clears the marker on href mismatch', () => {
	clearPreloadedNavigationData()
	markNavigationDataStale('/account')

	expect(consumeStaleNavigationData('/account/secrets')).toBe(false)
	expect(consumeStaleNavigationData('/account')).toBe(false)
})

test('consumeStaleNavigationData normalizes hrefs before matching', () => {
	clearPreloadedNavigationData()
	markNavigationDataStale('https://kody.local/account?q=1')

	expect(consumeStaleNavigationData('/account?q=1')).toBe(true)
})
