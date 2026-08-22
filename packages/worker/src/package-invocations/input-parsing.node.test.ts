import { expect, test } from 'vitest'
import {
	buildNormalizedPackageInvokeInput,
	parsePackageInvokeInput,
} from './input-parsing.ts'

test('parses preferred package specifiers, export subpaths, and the deprecated object form', () => {
	const packageOnly = parsePackageInvokeInput({
		specifier: 'kody:@kody/google',
		options: {
			exportName: 'profile',
			params: {},
			idempotencyKey: 'profile-1',
			topic: 'profiles',
		},
	})
	expect(packageOnly).toEqual({
		packageIdentifier: {
			kind: 'specifier',
			value: 'kody:@kody/google',
			packageName: '@kody/google',
		},
		packageIdOrKodyId: '@kody/google',
		exportName: 'profile',
		params: {},
		idempotencyKey: 'profile-1',
		topic: 'profiles',
	})

	const exportInSpecifier = parsePackageInvokeInput({
		specifier: 'kody:@kody/google/profile',
		options: {
			exportName: 'ignored',
			params: { includePhoto: true },
		},
	})
	expect(exportInSpecifier.exportName).toBe('profile')
	expect(
		buildNormalizedPackageInvokeInput({
			request: exportInSpecifier,
			exportName: './profile',
		}),
	).toEqual({
		specifier: 'kody:@kody/google/profile',
		exportName: './profile',
		params: { includePhoto: true },
	})

	const prefixless = parsePackageInvokeInput({
		specifier: '@kentcdodds/github',
		options: { exportName: '.' },
	})
	expect(prefixless.packageIdentifier).toEqual({
		kind: 'specifier',
		value: 'kody:@kentcdodds/github',
		packageName: '@kentcdodds/github',
	})
	expect(prefixless.exportName).toBe('.')

	const legacy = parsePackageInvokeInput({
		kodyId: 'github',
		exportName: 'profile',
		params: {},
		idempotencyKey: 'legacy-1',
	})
	expect(legacy.packageIdentifier).toEqual({
		kind: 'kodyId',
		value: 'github',
	})
	expect(legacy.exportName).toBe('profile')
})

test('validates specifier options and requires an export for package-only specifiers', () => {
	expect(() =>
		parsePackageInvokeInput({
			specifier: 'kody:@kody/google',
			options: {},
		}),
	).toThrow(
		'packages.invoke requires exportName when the package specifier has no export subpath.',
	)
	expect(() =>
		parsePackageInvokeInput({
			specifier: 'kody:@kody/google/profile',
			options: { unexpected: true },
		}),
	).toThrow('packages.invoke received unknown input key "unexpected"')
	expect(() =>
		parsePackageInvokeInput({
			specifier: 'google',
			options: { exportName: 'profile' },
		}),
	).toThrow('Unsupported Kody package specifier "google".')
})
