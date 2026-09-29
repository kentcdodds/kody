import { expect, test } from 'vitest'
import {
	type AccountProfileLoaderData,
	type AdminUsersLoaderData,
	type AppLoaderData,
} from '#universal/loader-data.ts'
import {
	clearPreloadedNavigationData,
	consumeStaleNavigationData,
	markNavigationDataStale,
	setPreloadedNavigationData,
	tryConsumePreloadedLoaderData,
} from './navigation-data.ts'

function profile(
	username = 'kody',
	displayName = 'Kody',
): AccountProfileLoaderData {
	return {
		ok: true,
		email: `${username}@example.com`,
		emailVerified: true,
		username,
		displayName,
		bio: null,
		avatarUrl: null,
		profileVisibility: 'public',
		formerEmails: [],
	}
}

test('preloaded navigation data is consumed once for matching hrefs and replaced on update', () => {
	const matching: Array<[setHref: string, consumeHref: string]> = [
		['/account', '/account'],
		['https://kody.local/account?q=1#top', '/account?q=1#top'],
		['/account', '/account#invite'],
	]
	for (const [setHref, consumeHref] of matching) {
		clearPreloadedNavigationData()
		setPreloadedNavigationData(setHref, { accountProfile: profile() })
		expect(
			tryConsumePreloadedLoaderData('accountProfile', consumeHref),
		).toEqual(profile())
		expect(
			tryConsumePreloadedLoaderData('accountProfile', consumeHref),
		).toBeUndefined()
	}

	clearPreloadedNavigationData()
	setPreloadedNavigationData('/account', { accountProfile: profile() })
	expect(
		tryConsumePreloadedLoaderData('accountProfile', '/account/secrets'),
	).toBeUndefined()
	expect(tryConsumePreloadedLoaderData('accountProfile', '/account')).toEqual(
		profile(),
	)

	clearPreloadedNavigationData()
	setPreloadedNavigationData('/account', {
		accountProfile: profile('first', 'First'),
	})
	setPreloadedNavigationData('/account', {
		accountProfile: profile('second', 'Second'),
	})
	expect(tryConsumePreloadedLoaderData('accountProfile', '/account')).toEqual(
		profile('second', 'Second'),
	)

	clearPreloadedNavigationData()
	const adminUsers: AdminUsersLoaderData = {
		ok: true,
		users: [],
		selectedUser: null,
		page: 1,
		pageSize: 25,
		total: 0,
		availableRoles: [],
		availablePlans: [],
	}
	const payload: Partial<AppLoaderData> = {
		accountProfile: profile(),
		adminUsers,
	}
	setPreloadedNavigationData('/account', payload)
	expect(tryConsumePreloadedLoaderData('accountProfile', '/account')).toEqual(
		profile(),
	)
	expect(tryConsumePreloadedLoaderData('adminUsers', '/account')).toEqual(
		adminUsers,
	)
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
