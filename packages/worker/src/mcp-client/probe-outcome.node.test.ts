import { expect, test } from 'vitest'
import {
	classifyOutboundMcpProbeSignal,
	classifyPersistedMcpSession,
	headerMismatchErrorCode,
	methodNotFoundErrorCode,
	shouldFallbackToLegacyInitialize,
	shouldPersistLegacyMcpSession,
	unsupportedProtocolVersionErrorCode,
} from './probe-outcome.ts'
import { modernMcpProtocolVersion } from './transport-session.ts'

test('unauthenticated and header-mismatch probes are not a 2025 verdict', () => {
	const unauthorized = classifyOutboundMcpProbeSignal({ httpStatus: 401 })
	expect(unauthorized).toEqual({ kind: 'auth-required' })
	expect(shouldFallbackToLegacyInitialize(unauthorized)).toBe(false)
	expect(shouldPersistLegacyMcpSession(unauthorized)).toBe(false)

	const headerMismatch = classifyOutboundMcpProbeSignal({
		httpStatus: 400,
		rpcCode: headerMismatchErrorCode,
	})
	expect(headerMismatch).toEqual({ kind: 'header-mismatch' })
	expect(shouldFallbackToLegacyInitialize(headerMismatch)).toBe(false)
	expect(shouldPersistLegacyMcpSession(headerMismatch)).toBe(false)

	const modern = classifyOutboundMcpProbeSignal({
		httpStatus: 200,
		discoverSupportedVersions: [modernMcpProtocolVersion],
	})
	expect(modern).toEqual({ kind: 'modern' })

	const initializeOnly = classifyOutboundMcpProbeSignal({
		rpcCode: methodNotFoundErrorCode,
	})
	expect(initializeOnly).toEqual({ kind: 'legacy' })
	expect(shouldFallbackToLegacyInitialize(initializeOnly)).toBe(true)
	expect(shouldPersistLegacyMcpSession(initializeOnly)).toBe(true)

	const unsupportedLegacy = classifyOutboundMcpProbeSignal({
		rpcCode: unsupportedProtocolVersionErrorCode,
		discoverSupportedVersions: ['2025-11-25'],
	})
	expect(unsupportedLegacy).toEqual({ kind: 'unknown' })
	expect(shouldFallbackToLegacyInitialize(unsupportedLegacy)).toBe(false)
	expect(shouldPersistLegacyMcpSession(unsupportedLegacy)).toBe(false)

	const unsupportedEmpty = classifyOutboundMcpProbeSignal({
		rpcCode: unsupportedProtocolVersionErrorCode,
	})
	expect(unsupportedEmpty).toEqual({ kind: 'unknown' })
	expect(shouldFallbackToLegacyInitialize(unsupportedEmpty)).toBe(false)
	expect(shouldPersistLegacyMcpSession(unsupportedEmpty)).toBe(false)

	const unrecognized = classifyOutboundMcpProbeSignal({
		httpStatus: 400,
		rpcCode: -32001,
	})
	expect(unrecognized).toEqual({ kind: 'unknown' })
	expect(shouldFallbackToLegacyInitialize(unrecognized)).toBe(false)
	expect(shouldPersistLegacyMcpSession(unrecognized)).toBe(false)

	const storedModern = classifyPersistedMcpSession({
		discoverResult: { supportedVersions: [modernMcpProtocolVersion] },
	})
	expect(storedModern).toEqual({ kind: 'modern' })
	expect(shouldPersistLegacyMcpSession(storedModern)).toBe(false)

	const storedStale = classifyPersistedMcpSession({
		discoverResult: { supportedVersions: ['2025-11-25'] },
	})
	expect(storedStale).toEqual({ kind: 'unknown' })
	expect(shouldPersistLegacyMcpSession(storedStale)).toBe(false)
})
