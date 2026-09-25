import { expect, test, vi } from 'vitest'

const exportsMock = vi.hoisted(() => ({
	PackageAppRuntimeBridge: undefined as unknown,
}))

vi.mock('cloudflare:workers', () => ({
	exports: exportsMock,
}))

const {
	hasLocalPackageAppRuntimeBridge,
	packageAppRuntimeBridgeMissingMessage,
	requireLocalPackageAppRuntimeBridge,
} = await import('./runtime-worker-service.ts')

test('requireLocalPackageAppRuntimeBridge fails closed when the export is missing', () => {
	exportsMock.PackageAppRuntimeBridge = undefined
	expect(hasLocalPackageAppRuntimeBridge()).toBe(false)
	expect(() => requireLocalPackageAppRuntimeBridge()).toThrow(
		packageAppRuntimeBridgeMissingMessage,
	)
})

test('requireLocalPackageAppRuntimeBridge returns the local bridge when present', () => {
	const bridge = vi.fn()
	exportsMock.PackageAppRuntimeBridge = bridge
	expect(hasLocalPackageAppRuntimeBridge()).toBe(true)
	expect(requireLocalPackageAppRuntimeBridge()).toBe(bridge)
})
