import { expect, test } from 'vitest'
import { type AppLoaderData } from '#app/loader-data.ts'
import {
	clearPreloadedNavigationData,
	consumeStaleNavigationData,
	markNavigationDataStale,
	setPreloadedNavigationData,
	tryConsumePreloadedLoaderData,
} from './navigation-data.ts'

test('preloaded navigation data is consumed once for matching hrefs and replaced on update', () => {
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

test('stale navigation markers are one-shot and normalize hrefs before matching', () => {
	clearPreloadedNavigationData()
	markNavigationDataStale('/account')

	expect(consumeStaleNavigationData('/account')).toBe(true)
	expect(consumeStaleNavigationData('/account')).toBe(false)

	clearPreloadedNavigationData()
	markNavigationDataStale('/account')
	expect(consumeStaleNavigationData('/account/secrets')).toBe(false)
	expect(consumeStaleNavigationData('/account')).toBe(false)

	clearPreloadedNavigationData()
	markNavigationDataStale('https://kody.local/account?q=1')
	expect(consumeStaleNavigationData('/account?q=1')).toBe(true)
})
