import { expect, test } from 'vitest'
import { ensureNavigationApi } from './ensure-navigation-api.ts'

test('ensureNavigationApi stubs a missing Navigation API so Remix boot can call updateCurrentEntry and leaves a real implementation alone', async () => {
	const assigns: Array<string> = []
	const replaces: Array<string> = []
	const hostWithoutNavigation = {
		location: {
			href: 'https://kody.codes/account',
			assign(url: string | URL) {
				assigns.push(String(url))
			},
			replace(url: string | URL) {
				replaces.push(String(url))
			},
		},
	}

	ensureNavigationApi(hostWithoutNavigation)

	const navigation = hostWithoutNavigation.navigation
	expect(typeof navigation?.updateCurrentEntry).toBe('function')
	expect(() => {
		navigation?.updateCurrentEntry({
			state: { target: undefined, src: 'https://kody.codes/account' },
		})
	}).not.toThrow()
	expect(navigation?.currentEntry?.url).toBe('https://kody.codes/account')
	expect(navigation?.currentEntry?.getState()).toEqual({
		target: undefined,
		src: 'https://kody.codes/account',
	})
	expect(navigation?.entries()).toHaveLength(1)

	const replaceResult = navigation?.navigate('https://kody.codes/login', {
		history: 'replace',
	})
	expect(replaces).toEqual(['https://kody.codes/login'])
	expect(assigns).toEqual([])
	await expect(replaceResult?.finished).resolves.toMatchObject({
		url: 'https://kody.codes/login',
	})

	const pushResult = navigation?.navigate('https://kody.codes/pricing')
	expect(assigns).toEqual(['https://kody.codes/pricing'])
	await expect(pushResult?.finished).resolves.toMatchObject({
		url: 'https://kody.codes/pricing',
	})

	const existingUpdate = () => {
		throw new Error('should not replace a real Navigation API')
	}
	const hostWithNavigation = {
		navigation: { updateCurrentEntry: existingUpdate },
		location: hostWithoutNavigation.location,
	}
	ensureNavigationApi(hostWithNavigation)
	expect(hostWithNavigation.navigation.updateCurrentEntry).toBe(existingUpdate)
})
