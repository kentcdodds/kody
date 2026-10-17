/**
 * Product knobs for personal-org → general-purpose conversion.
 * Keep email and free-org-cap defaults here so Kent can flip them in one place.
 */

/** When true, `{old}@inbox` stays on the converted org; the new personal org
 * gets a fresh `{new}@inbox`. When false (future), email would move with the person. */
export const convertPersonalOrgKeepEmailOnConvertedOrg = true

/**
 * When true, refuse conversion if minting the free personal org would put the
 * person over `MAX_FREE_ORGS_PER_USER` (the converted org still counts when free).
 */
export const convertPersonalOrgEnforceFreeOrgCap = true
