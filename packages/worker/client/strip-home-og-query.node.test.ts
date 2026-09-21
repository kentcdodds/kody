import { expect, test, vi } from 'vitest'
import { stripHomeOgQueryFromLocation } from './strip-home-og-query.ts'

test('stripHomeOgQueryFromLocation replaces only the og param', () => {
	const replaceState = vi.fn()
	vi.stubGlobal('window', {
		location: {
			href: 'https://kody.codes/?utm_source=youtube&og=cron#invite',
			pathname: '/',
			search: '?utm_source=youtube&og=cron',
			hash: '#invite',
		},
		history: { state: { key: 'scroll' }, replaceState },
	})

	expect(stripHomeOgQueryFromLocation()).toBe(true)
	expect(replaceState).toHaveBeenCalledWith(
		{ key: 'scroll' },
		'',
		'/?utm_source=youtube#invite',
	)

	replaceState.mockClear()
	vi.stubGlobal('window', {
		location: {
			href: 'https://kody.codes/',
			pathname: '/',
			search: '',
			hash: '',
		},
		history: { state: null, replaceState },
	})
	expect(stripHomeOgQueryFromLocation()).toBe(false)
	expect(replaceState).not.toHaveBeenCalled()

	vi.unstubAllGlobals()
})
