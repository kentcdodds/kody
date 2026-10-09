import { expect, test, vi } from 'vitest'

const exportsMock = vi.hoisted(() => ({
	PackageAppRuntimeBridge: undefined as unknown,
}))

vi.mock('cloudflare:workers', () => ({
	exports: exportsMock,
}))

const { hasLocalPackageAppRuntimeBridge, requireLocalPackageAppRuntimeBridge } =
	await import('./runtime-worker-service.ts')

test('requireLocalPackageAppRuntimeBridge fails closed until the export is present', () => {
	exportsMock.PackageAppRuntimeBridge = undefined
	expect(hasLocalPackageAppRuntimeBridge()).toBe(false)
	expect(() => requireLocalPackageAppRuntimeBridge()).toThrow(
		/PackageAppRuntimeBridge/,
	)

	const bridge = vi.fn()
	exportsMock.PackageAppRuntimeBridge = bridge
	expect(hasLocalPackageAppRuntimeBridge()).toBe(true)
	expect(requireLocalPackageAppRuntimeBridge()).toBe(bridge)
})
