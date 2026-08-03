import { readdirSync, readFileSync } from 'node:fs'
import { type DatabaseSync } from 'node:sqlite'

const destructiveEmailGraphMigration = '0134-drop-legacy-email-graph.sql'

function prepareEmailGraphDropApproval(db: DatabaseSync) {
	db.exec(`
		CREATE TABLE email_user_graph_drop_approval (
			singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
			authority_frozen_at TEXT NOT NULL,
			backup_object_key TEXT NOT NULL,
			backup_sha256 TEXT NOT NULL,
			verified_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			owner_count INTEGER NOT NULL CHECK (owner_count >= 0),
			thread_count INTEGER NOT NULL CHECK (thread_count >= 0),
			message_count INTEGER NOT NULL CHECK (message_count >= 0),
			attachment_count INTEGER NOT NULL CHECK (attachment_count >= 0),
			delivery_event_count INTEGER NOT NULL CHECK (delivery_event_count >= 0)
		);
		INSERT INTO email_user_graph_drop_approval (
			singleton, authority_frozen_at, backup_object_key, backup_sha256,
			verified_at, expires_at, owner_count, thread_count, message_count,
			attachment_count, delivery_event_count
		)
		SELECT
			1, authority.frozen_at, 'test/verified-d1-backup.sql.gz',
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'2000-01-01T00:00:00Z', '2999-01-01T00:00:00Z',
			authority.owner_count,
			(SELECT COUNT(*) FROM email_threads WHERE user_id != 'system:email'),
			(SELECT COUNT(*) FROM email_messages WHERE user_id != 'system:email'),
			(
				SELECT COUNT(*)
				FROM email_attachments attachment
				INNER JOIN email_messages message ON message.id = attachment.message_id
				WHERE message.user_id != 'system:email'
			),
			(
				SELECT COUNT(*) FROM email_delivery_events
				WHERE user_id != 'system:email'
			)
		FROM email_user_graph_authority authority
		WHERE authority.singleton = 1;
	`)
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
