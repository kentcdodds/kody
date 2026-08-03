import { readdirSync, readFileSync } from 'node:fs'
import { type DatabaseSync } from 'node:sqlite'

export function applyAllMigrations(db: DatabaseSync, migrationsDirectory: URL) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}
