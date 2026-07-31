import {
	applyD1Migrations,
	env,
	readD1Migrations,
} from 'cloudflare:test'

const auditMigrations = await readD1Migrations(
	'packages/worker/audit-migrations',
)

await applyD1Migrations(env.AUDIT_DB, auditMigrations)
