import { expect, test } from 'vitest'
import {
	classifyOutboundMcpProbeSignal,
	headerMismatchErrorCode,
	methodNotFoundErrorCode,
	unsupportedProtocolVersionErrorCode,
} from './probe-outcome.ts'
import { modernMcpProtocolVersion } from './transport-session.ts'

test('unauthenticated and header-mismatch probes are not a 2025 verdict', () => {
	expect(classifyOutboundMcpProbeSignal({ httpStatus: 401 })).toEqual({
		kind: 'auth-required',
	})
	expect(
		classifyOutboundMcpProbeSignal({
			httpStatus: 400,
			rpcCode: headerMismatchErrorCode,
		}),
	).toEqual({ kind: 'header-mismatch' })
	expect(
		classifyOutboundMcpProbeSignal({
			httpStatus: 200,
			discoverSupportedVersions: [modernMcpProtocolVersion],
		}),
	).toEqual({ kind: 'modern' })
	expect(
		classifyOutboundMcpProbeSignal({
			rpcCode: methodNotFoundErrorCode,
		}),
	).toEqual({ kind: 'legacy' })
	expect(
		classifyOutboundMcpProbeSignal({
			rpcCode: unsupportedProtocolVersionErrorCode,
			discoverSupportedVersions: ['2025-11-25'],
		}),
	).toEqual({ kind: 'unknown' })
})
