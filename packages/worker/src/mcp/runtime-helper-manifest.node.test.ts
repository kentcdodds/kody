import { expect, test, vi } from 'vitest'
import { createRuntimeHelperPreludes } from './runtime-helper-manifest.ts'

test('packages helper forwards string-first invoke and rejects the removed object form locally', async () => {
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
			specifier: string,
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
		(packages.invoke as (input: unknown) => Promise<unknown>)({
			kodyId: 'google',
			exportName: 'profile',
		}),
	).rejects.toThrow('Object-only packages.invoke was removed')
	expect(invoke).toHaveBeenCalledTimes(1)
})
