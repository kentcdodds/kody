import { readdirSync, readFileSync } from 'node:fs'
import { type DatabaseSync } from 'node:sqlite'

const destructiveEmailGraphMigration = '0135-drop-legacy-email-graph.sql'
const localApprovalFixture = new URL(
	'../../../../tools/local-mailbox-pre-drop-approval-fixture.sql',
	import.meta.url,
)

function prepareEmailGraphDropApproval(db: DatabaseSync) {
	db.exec(readFileSync(localApprovalFixture, 'utf8'))
}

export function applyAllMigrations(db: DatabaseSync, migrationsDirectory: URL) {
	for (const fileName of readdirSync(migrationsDirectory)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		if (fileName === destructiveEmailGraphMigration) {
			prepareEmailGraphDropApproval(db)
		}
		db.exec(readFileSync(new URL(fileName, migrationsDirectory), 'utf8'))
	}
}
