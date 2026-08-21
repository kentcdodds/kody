import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from './manifest.ts'
import {
	kodyPackageDependencyWildcard,
	listKodyPackageDependencyNames,
} from './types.ts'

function manifest(dependencies: unknown) {
	return JSON.stringify({
		name: '@scope/demo',
		exports: { '.': './index.ts' },
		kody: {
			id: 'demo',
			description: 'Demo package',
			dependencies,
		},
	})
}

test('kody.dependencies accepts a name-to-* map, rejects arrays, and lists names from either raw shape', () => {
	expect(listKodyPackageDependencyNames(undefined)).toEqual([])
	expect(
		listKodyPackageDependencyNames(['@scope/b', ' @scope/a ', '@scope/b']),
	).toEqual(['@scope/a', '@scope/b'])
	expect(listKodyPackageDependencyNames([1, '@scope/a', null])).toEqual([
		'@scope/a',
	])
	expect(
		listKodyPackageDependencyNames({
			'@scope/b': '*',
			'@scope/a': 'latest',
		}),
	).toEqual(['@scope/a', '@scope/b'])

	const fromMap = parseAuthoredPackageJson({
		content: manifest({
			'@scope/helper': '*',
			'@other/lib': '*',
		}),
	})
	expect(fromMap.kody.dependencies).toEqual({
		'@other/lib': kodyPackageDependencyWildcard,
		'@scope/helper': kodyPackageDependencyWildcard,
	})

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest({ '@scope/helper': 'latest' }),
		}),
	).toThrow(/must be "\*"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest({ '@scope/helper': '^1.2.3' }),
		}),
	).toThrow(/must be "\*"/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest({ helper: '*' }),
		}),
	).toThrow(/scoped package names/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest(['@scope/helper', '@other/lib']),
		}),
	).toThrow(/must be a map/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest([1, '@scope/helper']),
		}),
	).toThrow(/must be a map/)
})
