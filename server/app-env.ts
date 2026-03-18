let appDb: D1Database | null = null

export function setAppDb(db: D1Database) {
	appDb = db
}

export function getAppDb() {
	if (!appDb) {
		throw new Error('APP_DB binding is not configured.')
	}
	return appDb
}
