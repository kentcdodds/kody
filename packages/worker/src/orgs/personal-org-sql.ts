/**
 * Join predicate from a live `users` alias `u` to that person's personal org.
 * Prefers `u.personal_org_id` when populated; else `u.stable_user_id` so
 * equal-id fixtures and any blank-column row still resolve. Production live
 * rows are asserted non-blank by migration 0146 (#3053 phase 3).
 */
export const personalOrgIdSql = `COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)`

/** `INNER JOIN orgs o ON o.id = <personal org for u>` */
export const joinOrgsOnPersonalOrgIdSql = `INNER JOIN orgs o ON o.id = ${personalOrgIdSql}`

/** `LEFT JOIN orgs o ON o.id = <personal org for u>` */
export const leftJoinOrgsOnPersonalOrgIdSql = `LEFT JOIN orgs o ON o.id = ${personalOrgIdSql}`
