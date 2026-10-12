/**
 * Workers-unit D1 does not apply migrations. Ensure the internet-visible
 * column exists on hand-rolled saved_packages schemas.
 */
export async function ensureSavedPackageInternetVisibleColumn(db: D1Database) {
	try {
		await db
			.prepare(
				`ALTER TABLE saved_packages ADD COLUMN is_internet_visible INTEGER NOT NULL DEFAULT 0`,
			)
			.run()
	} catch {
		// Column already present on CREATE TABLE or a prior ensure call.
	}
}
