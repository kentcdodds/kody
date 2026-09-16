import { normalizePackageInvocationExportName } from '@kody-internal/shared/public-urls.ts'
import { createSealedSecretProviderExportDeniedMessage } from './errors.ts'

/**
 * Well-known export the platform invokes in sealed mode. Provider packages
 * must declare this export; ordinary execute / invoke / kody:@ import of it
 * is rejected so `{ value }` never becomes an RPC or import result.
 */
export const sealedSecretProviderExportName = './secretProvider'

export function isSealedSecretProviderExport(exportName: string) {
	try {
		return (
			normalizePackageInvocationExportName(exportName) ===
			sealedSecretProviderExportName
		)
	} catch {
		return false
	}
}

export function assertNotSealedSecretProviderExport(exportName: string) {
	if (isSealedSecretProviderExport(exportName)) {
		throw new Error(createSealedSecretProviderExportDeniedMessage())
	}
}

export function sealedSecretProviderExportDeniedResponse() {
	return {
		status: 403 as const,
		code: 'sealed_secret_provider' as const,
		message: createSealedSecretProviderExportDeniedMessage(),
	}
}
