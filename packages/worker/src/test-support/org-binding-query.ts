/**
 * Recognize `loadOrgBindingForPerson` / `loadOrgBindingForOrg` membership
 * SELECTs so D1 stubs can return a live personal-org row.
 */
export function isOrgBindingMembershipQuery(normalizedQuery: string) {
	return (
		normalizedQuery.includes('from org_memberships') &&
		normalizedQuery.includes('inner join orgs')
	)
}

export function mockPersonalOrgBindingRow(
	personId: string,
	slug: string | null = null,
) {
	return {
		org_id: personId,
		org_slug: slug,
		role: 'owner' as const,
	}
}

/**
 * D1 stub where every person is a live Owner of their personal org, so
 * `resolveCredential`'s org access check passes. Other queries find nothing.
 */
export function personalOrgAccessD1(): D1Database {
	return {
		prepare(query: string) {
			const normalizedQuery = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first() {
							return isOrgBindingMembershipQuery(normalizedQuery)
								? mockPersonalOrgBindingRow(String(params[1]))
								: null
						},
						async all() {
							return { results: [], meta: { changes: 0 } }
						},
						async run() {
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}
