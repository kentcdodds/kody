/**
 * Join predicate from a live `users` alias `u` to that person's personal org.
 * Prefers `u.personal_org_id` when populated (phase 2+), else `u.stable_user_id`
 * so widened and pre-widen rows both resolve during rolling deploys.
 */
export const personalOrgIdSql = `COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)`

/** `INNER JOIN orgs o ON o.id = <personal org for u>` */
export const joinOrgsOnPersonalOrgIdSql = `INNER JOIN orgs o ON o.id = ${personalOrgIdSql}`

/** `LEFT JOIN orgs o ON o.id = <personal org for u>` */
export const leftJoinOrgsOnPersonalOrgIdSql = `LEFT JOIN orgs o ON o.id = ${personalOrgIdSql}`
