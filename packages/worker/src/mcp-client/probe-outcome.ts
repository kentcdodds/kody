/**
 * Outbound era classification for Kody-as-client.
 *
 * Client 2.0.0 `classifyProbeOutcome` treats HeaderMismatch (-32020) and most
 * unrecognized probe failures as a 2025 server, then sends `initialize`.
 * Unauthenticated (401) and header-mismatch outcomes are not era evidence:
 * retry `server/discover` after the token is available, and do not persist a
 * legacy session from those probes. Fall back to `initialize` only when the
 * server is actually 2025-era.
 */

import { modernMcpProtocolVersion } from './transport-session.ts'

export const headerMismatchErrorCode = -32020
export const unsupportedProtocolVersionErrorCode = -32022
export const methodNotFoundErrorCode = -32601

export type OutboundMcpProbeSignal =
	| { kind: 'modern' }
	| { kind: 'legacy' }
	| { kind: 'auth-required' }
	| { kind: 'header-mismatch' }
	| { kind: 'unknown' }

export function classifyOutboundMcpProbeSignal(input: {
	httpStatus?: number
	rpcCode?: number
	discoverSupportedVersions?: ReadonlyArray<string>
}): OutboundMcpProbeSignal {
	if (input.httpStatus === 401 || input.httpStatus === 403) {
		return { kind: 'auth-required' }
	}
	if (input.rpcCode === headerMismatchErrorCode) {
		return { kind: 'header-mismatch' }
	}
	if (input.discoverSupportedVersions?.includes(modernMcpProtocolVersion)) {
		return { kind: 'modern' }
	}
	if (input.rpcCode === methodNotFoundErrorCode) {
		return { kind: 'legacy' }
	}
	if (input.rpcCode === unsupportedProtocolVersionErrorCode) {
		const supported = input.discoverSupportedVersions ?? []
		const hasLegacy = supported.some((version) => version.startsWith('2025-'))
		if (hasLegacy || supported.length === 0) return { kind: 'legacy' }
	}
	return { kind: 'unknown' }
}

export function shouldFallbackToLegacyInitialize(
	signal: OutboundMcpProbeSignal,
): boolean {
	return signal.kind === 'legacy'
}

export function shouldPersistLegacyMcpSession(
	signal: OutboundMcpProbeSignal,
): boolean {
	return signal.kind === 'legacy'
}
