import { expect, test } from 'vitest'
import {
	buildPackageAppPath,
	buildPackageAppSubdomainPath,
	buildPackagePagePath,
} from './public-urls.ts'

test('saved-package pages and hosted package-app mounts use different paths', () => {
	expect(
		buildPackagePagePath({ username: 'kentcdodds', kodyId: 'hn-pulse' }),
	).toBe('/@kentcdodds/hn-pulse')
	expect(
		buildPackageAppPath({ username: 'kentcdodds', kodyId: 'hn-pulse' }),
	).toBe('/@kentcdodds/packages/hn-pulse')
	expect(
		buildPackageAppPath({
			username: 'kentcdodds',
			kodyId: 'hn-pulse',
			restPath: '/report',
		}),
	).toBe('/@kentcdodds/packages/hn-pulse/report')
	expect(buildPackageAppSubdomainPath({ kodyId: 'hn-pulse' })).toBe(
		'/packages/hn-pulse',
	)
	expect(
		buildPackageAppSubdomainPath({ kodyId: 'hn-pulse', restPath: '/report' }),
	).toBe('/packages/hn-pulse/report')
})
