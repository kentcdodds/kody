import { expect, test } from 'vitest'
import {
	buildNormalizedPackageInvokeInput,
	parsePackageInvokeInput,
} from './input-parsing.ts'

test('parses and canonicalizes scoped package specifiers and export subpaths', () => {
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
		specifier: 'kody:@kody/google',
		packageName: '@kody/google',
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

	const prefixlessPackage = parsePackageInvokeInput({
		specifier: '@kentcdodds/github',
		options: { exportName: '.', params: { owner: 'kentcdodds' } },
	})
	expect(prefixlessPackage).toMatchObject({
		specifier: 'kody:@kentcdodds/github',
		packageName: '@kentcdodds/github',
		exportName: '.',
		params: { owner: 'kentcdodds' },
	})

	const prefixlessExport = parsePackageInvokeInput({
		specifier: '@kentcdodds/github/request',
		options: { exportName: 'ignored', params: { path: '/user' } },
	})
	expect(prefixlessExport).toMatchObject({
		specifier: 'kody:@kentcdodds/github/request',
		packageName: '@kentcdodds/github',
		exportName: 'request',
		params: { path: '/user' },
	})

	const spacedPrefixless = parsePackageInvokeInput({
		specifier: '@kentcdodds / github/request',
		options: {},
	})
	expect(spacedPrefixless).toMatchObject({
		specifier: 'kody:@kentcdodds / github/request',
		packageName: '@kentcdodds/github',
		exportName: 'request',
	})
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
	).toThrow(
		'requires a kody:@owner/package[/export] or @owner/package[/export] specifier',
	)
})
