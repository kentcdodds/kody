import {
	readOrgIdFromGrantProps,
	readOrgIdFromGrantPropsOrUserId,
} from '#worker/orgs/oauth-grant.ts'
import {
	loadOrgBindingForOrg,
	loadOrgBindingForPerson,
	type OrgBinding,
} from '#worker/orgs/repo.ts'

/**
 * Resolve the org this MCP OAuth grant is bound to.
 *
 * Stamped `props.orgId` is authoritative. Grants minted before P4 have no
 * orgId — fall back to `props.userId` as the personal org id (P9 cleanup:
 * drop the userId fallback once every live grant has orgId; see ADR 0064).
 */
export async function loadOrgBindingFromGrantProps(input: {
	db: D1Database
	personId: string
	grantProps: unknown
}): Promise<OrgBinding | null> {
	const stampedOrgId = readOrgIdFromGrantProps(input.grantProps)
	if (stampedOrgId) {
		return await loadOrgBindingForOrg(input.db, input.personId, stampedOrgId)
	}
	const fallbackOrgId = readOrgIdFromGrantPropsOrUserId(input.grantProps)
	if (fallbackOrgId) {
		// ADR 0064: orgId ?? userId only. Do not fall through to the caller's
		// personal org when that lookup fails (hides props.userId mismatch).
		return await loadOrgBindingForOrg(input.db, input.personId, fallbackOrgId)
	}
	try {
		return await loadOrgBindingForPerson(input.db, input.personId)
	} catch {
		return null
	}
}
