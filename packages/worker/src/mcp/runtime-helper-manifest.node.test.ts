import { expect, test, vi } from 'vitest'
import {
	createRuntimeHelperPreludes,
	createRuntimeHelperRuntimePropertySource,
	createUnboundOptionalRuntimeHelperNames,
} from './runtime-helper-manifest.ts'

test('packages helper is never bound: no prelude and always unbound', () => {
	const context = {
		env: {} as Env,
		callerContext: { user: { userId: 'user-1' } } as never,
		capabilityMap: {},
	}
	const preludes = createRuntimeHelperPreludes(context).join('\n')
	expect(preludes).not.toContain('const packages =')
	expect(preludes).not.toContain('__kodyPackageInvokeRuntimeBridge')
	expect(createUnboundOptionalRuntimeHelperNames(context).has('packages')).toBe(
		true,
	)
	expect(createRuntimeHelperRuntimePropertySource()).toContain(
		"packages: typeof packages === 'undefined' ? null : packages,",
	)
})

test('packageSecrets prelude reads the run package id from evaluate invocation', () => {
	const first = createRuntimeHelperPreludes({
		env: {} as Env,
		callerContext: { user: { userId: 'user-1' } } as never,
		capabilityMap: {},
		packageSecretTools: {
			get: async () => '',
			has: async () => false,
			runPackageId: 'pkg-a',
		},
	}).join('\n')
	const second = createRuntimeHelperPreludes({
		env: {} as Env,
		callerContext: { user: { userId: 'user-1' } } as never,
		capabilityMap: {},
		packageSecretTools: {
			get: async () => '',
			has: async () => false,
			runPackageId: 'pkg-b',
		},
	}).join('\n')
	expect(first).toBe(second)
	expect(first).toContain('__kodyTrustedPackageId')
	expect(first).toContain('__kodyPackageSecrets(__kodyTrustedPackageId)')
	expect(first).not.toContain('__invocation.packageContext')
})

test('computed package import helper prelude forwards callDefault to the host bridge', async () => {
	const callDefault = vi.fn(async (input: unknown) => input)
	const preludes = createRuntimeHelperPreludes({
		env: {} as Env,
		callerContext: { user: { userId: 'user-1' } } as never,
		capabilityMap: {},
		computedPackageImportTools: { callDefault },
	})
	const prelude = preludes.find((entry) =>
		entry.includes('__kodyComputedPackageImport'),
	)
	expect(prelude).toBeDefined()
	const createHelper = new Function(
		'__kodyComputedPackageImportRuntimeBridge',
		`${prelude}; return __kodyComputedPackageImport;`,
	) as (bridge: { callDefault(input: unknown): Promise<unknown> }) => {
		callDefault(input: {
			specifier: string
			params?: Record<string, unknown>
		}): Promise<unknown>
	}
	const helper = createHelper({ callDefault })
	await expect(
		helper.callDefault({
			specifier: 'kody:@kentcdodds/example/probe',
			params: { marker: 'ok' },
		}),
	).resolves.toEqual({
		specifier: 'kody:@kentcdodds/example/probe',
		params: { marker: 'ok' },
	})
	expect(callDefault).toHaveBeenCalledTimes(1)
})
