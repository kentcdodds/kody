import {
	readOrgIdFromGrantProps,
	readOrgIdFromGrantPropsOrUserId,
} from '#worker/orgs/oauth-grant.ts'
import {
	loadOrgBindingForOrg,
	loadOrgBindingForPerson,
	orgBindingForOrgFromRows,
	orgBindingForOrgStatements,
	orgBindingForPersonFromRow,
	orgBindingForPersonStatement,
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

export type OrgBindingPlan = {
	/** Statements to run in the same D1 batch as the caller's other reads. */
	statements: Array<D1PreparedStatement>
	/** First row of each statement's result, in `statements` order. */
	resolve: (rows: Array<unknown>) => OrgBinding | null
}

/**
 * Same resolution as {@link loadOrgBindingFromGrantProps}, but as prepared
 * statements so the caller can read the binding in one D1 batch (one
 * transaction) together with the user row it gates on.
 */
export function planOrgBindingFromGrantProps(input: {
	db: D1Database
	personId: string
	grantProps: unknown
}): OrgBindingPlan {
	const orgId =
		readOrgIdFromGrantProps(input.grantProps) ??
		readOrgIdFromGrantPropsOrUserId(input.grantProps)
	if (orgId) {
		const statements = orgBindingForOrgStatements(
			input.db,
			input.personId,
			orgId,
		)
		return {
			statements: [statements.membership, statements.grant],
			resolve: (rows) =>
				orgBindingForOrgFromRows({
					membership: (rows[0] ?? null) as Parameters<
						typeof orgBindingForOrgFromRows
					>[0]['membership'],
					grant: (rows[1] ?? null) as Parameters<
						typeof orgBindingForOrgFromRows
					>[0]['grant'],
				}),
		}
	}
	return {
		statements: [orgBindingForPersonStatement(input.db, input.personId)],
		resolve: (rows) => {
			try {
				return orgBindingForPersonFromRow(
					input.personId,
					(rows[0] ?? null) as Parameters<typeof orgBindingForPersonFromRow>[1],
				)
			} catch {
				return null
			}
		},
	}
}
