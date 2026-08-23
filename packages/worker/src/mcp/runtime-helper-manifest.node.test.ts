import { expect, test, vi } from 'vitest'
import { createRuntimeHelperPreludes } from './runtime-helper-manifest.ts'

test('packages helper prefers string-first invoke and preserves the legacy object form', async () => {
	const invoke = vi.fn(async (input: unknown) => input)
	const [prelude] = createRuntimeHelperPreludes({
		env: {} as Env,
		callerContext: {} as never,
		capabilityMap: {},
		packageInvokeTools: { invoke },
	})
	expect(prelude).toBeDefined()
	const createPackages = new Function(
		'__kodyPackageInvokeRuntimeBridge',
		`${prelude}; return packages;`,
	) as (bridge: { invoke(input: unknown): Promise<unknown> }) => {
		invoke(
			specifierOrInput: string | Record<string, unknown>,
			options?: Record<string, unknown>,
		): Promise<unknown>
	}
	const packages = createPackages({ invoke })

	await expect(
		packages.invoke('kody:@kody/google/profile', { params: {} }),
	).resolves.toEqual({
		specifier: 'kody:@kody/google/profile',
		options: { params: {} },
	})
	await expect(
		packages.invoke({
			kodyId: 'google',
			exportName: 'profile',
			params: {},
		}),
	).resolves.toEqual({
		kodyId: 'google',
		exportName: 'profile',
		params: {},
	})
})
