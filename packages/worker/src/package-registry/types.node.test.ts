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

test('kody.dependencies accepts a name-to-* map and a legacy name array, and lists names from either shape', () => {
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

	const fromArray = parseAuthoredPackageJson({
		content: manifest(['@scope/helper', '@other/lib']),
	})
	expect(fromArray.kody.dependencies).toEqual({
		'@other/lib': kodyPackageDependencyWildcard,
		'@scope/helper': kodyPackageDependencyWildcard,
	})

	const fromMap = parseAuthoredPackageJson({
		content: manifest({
			'@scope/helper': '*',
			'@other/lib': '*',
		}),
	})
	expect(fromMap.kody.dependencies).toEqual({
		'@other/lib': '*',
		'@scope/helper': '*',
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
			content: manifest(['@scope/helper', '@scope/helper']),
		}),
	).toThrow(/Duplicate static Kody package dependency/)

	expect(() =>
		parseAuthoredPackageJson({
			content: manifest(['helper']),
		}),
	).toThrow(/scoped package names/)

	// Zod 4 still runs transform after non-fatal superRefine issues. A
	// non-string array entry must stay a schema failure, not a throw from trim.
	expect(() =>
		parseAuthoredPackageJson({
			content: manifest([1, '@scope/helper']),
		}),
	).toThrow(/scoped package names/)
	expect(() =>
		parseAuthoredPackageJson({
			content: manifest([null]),
		}),
	).toThrow(/scoped package names/)
})
