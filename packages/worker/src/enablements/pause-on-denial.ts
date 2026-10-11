import { type AuthorizationError } from '#worker/authorization/authorize.ts'
import { pauseEnablement, type EnablementPauseInput } from './repo.ts'

/** The pause an access denial maps to. A wrong org means the enabler left. */
export function enablementPauseForDenial(
	error: AuthorizationError,
): EnablementPauseInput {
	if (error.code === 'wrong_org') {
		return { reason: 'org_access', permission: error.permission }
	}
	return {
		reason:
			error.resource?.type === 'package'
				? 'package_access'
				: 'credential_access',
		permission: error.permission,
		resourceType: error.resource?.type ?? null,
		resourceId: error.resource?.id ?? null,
	}
}

/**
 * Pause the enablement whose run was just denied. The run fails with the
 * denial; the next event checks access again and resumes it once restored.
 */
export async function pauseEnablementOnDenial(input: {
	db: D1Database
	orgId: string
	enablementId: string
	error: AuthorizationError
}) {
	try {
		await pauseEnablement({
			db: input.db,
			orgId: input.orgId,
			id: input.enablementId,
			pause: enablementPauseForDenial(input.error),
		})
	} catch (error) {
		console.error('enablement-pause-on-denial-failed', {
			orgId: input.orgId,
			enablementId: input.enablementId,
			error,
		})
	}
}
