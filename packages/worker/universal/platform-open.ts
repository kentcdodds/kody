/**
 * Public launch of kody.codes. Admin launch-cohort filters use this
 * instant; it is not a stored setting.
 */
export const platformPublicOpenedAt = '2026-09-10T00:00:00.000Z'

/** UTC calendar day of {@link platformPublicOpenedAt}, for D1 prefix filters. */
export const platformPublicOpenedDay = platformPublicOpenedAt.slice(
	0,
	'YYYY-MM-DD'.length,
)
