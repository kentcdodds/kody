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
