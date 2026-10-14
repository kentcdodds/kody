import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createAuditTestDb,
	createTestOrgAuditWriter,
} from '#worker/test-support/create-audit-db.ts'
import {
	credentialHostsMax,
	parseCredentialHostsInput,
	readCredentialHostSettings,
	updateCredentialHosts,
} from './credential-hosts.ts'
import { getOrgCredential } from './credential-ids.ts'

const orgId = 'org-1'

function setup() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	sqlite.exec(`
		INSERT INTO user_oauth_apps (user_id, slug, provider, client_id, token_url, api_base_url, flow)
		VALUES ('org-1', 'dropbox', 'dropbox', 'dbx-client',
			'https://api.dropboxapi.com/oauth2/token', 'https://api.dropboxapi.com', 'pkce');
		INSERT INTO platform_oauth_apps (
			slug, provider, client_id, token_url, authorize_url, flow, required_hosts_json
		) VALUES ('github-platform', 'github', 'gh-client',
			'https://github.com/login/oauth/access_token',
			'https://github.com/login/oauth/authorize', 'confidential',
			'["api.github.com"]');
		INSERT INTO user_integrations (
			id, user_id, name, app_slug, platform_app_slug, required_hosts_json,
			access_token_encrypted, updated_at
		) VALUES
			('cred-dropbox', 'org-1', 'dropbox', 'dropbox', NULL, '["api.dropboxapi.com"]',
				'ct-dropbox', '2026-10-01T00:00:00.000Z'),
			('cred-github', 'org-1', 'github', NULL, 'github-platform',
				'["api.github.com","uploads.github.com"]',
				'ct-github', '2026-10-01T00:00:00.000Z'),
			('cred-other-org', 'org-2', 'dropbox', NULL, 'github-platform', '[]',
				'ct-other', '2026-10-01T00:00:00.000Z');
		INSERT INTO secret_buckets (id, user_id, scope, binding_key)
		VALUES ('bucket-1', 'org-1', 'user', '');
		INSERT INTO secret_entries (id, bucket_id, name, encrypted_value, allowed_hosts, kind)
		VALUES
			('cred-key', 'bucket-1', 'openai', 'ct-key', '["api.openai.com"]', 'secret'),
			('cred-url', 'bucket-1', 'webhook', 'ct-url', '["hooks.example.com"]', 'url');
	`)
	const db = createD1FromSqlite(sqlite)
	const auditDb = createAuditTestDb()
	const audit = createTestOrgAuditWriter({ appDb: db, db: auditDb })
	return { sqlite, db, auditDb, audit }
}

async function readAuditRows(auditDb: D1Database) {
	const result = await auditDb
		.prepare(
			`SELECT action, resource_id, details_json FROM org_audit_events ORDER BY rowid`,
		)
		.all<{ action: string; resource_id: string; details_json: string }>()
	return (result.results ?? []).map((row) => ({
		action: row.action,
		resourceId: row.resource_id,
		details: JSON.parse(row.details_json) as Record<string, unknown>,
	}))
}

async function credential(db: D1Database, id: string) {
	const found = await getOrgCredential(db, orgId, id)
	if (!found) throw new Error(`missing ${id}`)
	return found
}

test('host input accepts public HTTPS host names and normalizes them', () => {
	expect(
		parseCredentialHostsInput([
			'https://Content.DropboxAPI.com/',
			'api.dropboxapi.com',
			'  ',
			'api.dropboxapi.com',
		]),
	).toEqual({
		ok: true,
		hosts: ['api.dropboxapi.com', 'content.dropboxapi.com'],
	})
})

test.each([
	['http://api.example.com', 'only over HTTPS'],
	['ftp://api.example.com', 'host name'],
	['*.example.com', 'wildcards'],
	['api.example.com:8443', 'no port'],
	['api.example.com/upload', 'no port, path'],
	['localhost', 'not localhost or an IP'],
	['10.0.0.1', 'not localhost or an IP'],
	['not a host', 'no port'],
])('host input rejects %s', (raw, message) => {
	const parsed = parseCredentialHostsInput([raw])
	expect(parsed.ok).toBe(false)
	if (!parsed.ok) expect(parsed.error).toContain(message)
})

test('host input rejects non-strings and more than the maximum', () => {
	expect(parseCredentialHostsInput([42]).ok).toBe(false)
	const many = Array.from(
		{ length: credentialHostsMax + 1 },
		(_, index) => `h${index}.example.com`,
	)
	expect(parseCredentialHostsInput(many)).toEqual({
		ok: false,
		error: `A credential can allow at most ${credentialHostsMax} hosts.`,
	})
})

test('an OAuth connection adds hosts beside its fixed API host, audited, token untouched', async () => {
	const { sqlite, db, auditDb, audit } = setup()
	expect(
		await readCredentialHostSettings({
			db,
			orgId,
			credential: await credential(db, 'cred-dropbox'),
		}),
	).toEqual({ hosts: [], fixedHosts: ['api.dropboxapi.com'] })

	const updated = await updateCredentialHosts({
		db,
		orgId,
		credentialId: 'cred-dropbox',
		hosts: ['content.dropboxapi.com', 'notify.dropboxapi.com'],
		audit,
	})
	expect(updated).toEqual({
		hosts: ['content.dropboxapi.com', 'notify.dropboxapi.com'],
		fixedHosts: ['api.dropboxapi.com'],
		changed: true,
	})
	const row = sqlite
		.prepare(
			`SELECT required_hosts_json, access_token_encrypted FROM user_integrations WHERE id = 'cred-dropbox'`,
		)
		.get() as { required_hosts_json: string; access_token_encrypted: string }
	expect(JSON.parse(row.required_hosts_json)).toEqual([
		'api.dropboxapi.com',
		'content.dropboxapi.com',
		'notify.dropboxapi.com',
	])
	expect(row.access_token_encrypted).toBe('ct-dropbox')
	expect(await readAuditRows(auditDb)).toEqual([
		{
			action: 'credential.hosts_updated',
			resourceId: 'cred-dropbox',
			details: {
				credentialKind: 'integration',
				name: 'dropbox',
				hosts: {
					before: ['api.dropboxapi.com'],
					after: [
						'api.dropboxapi.com',
						'content.dropboxapi.com',
						'notify.dropboxapi.com',
					],
				},
			},
		},
	])
})

test('a built-in app keeps its fixed hosts even when the edit omits them', async () => {
	const { sqlite, db, audit } = setup()
	expect(
		await readCredentialHostSettings({
			db,
			orgId,
			credential: await credential(db, 'cred-github'),
		}),
	).toEqual({ hosts: ['uploads.github.com'], fixedHosts: ['api.github.com'] })

	await updateCredentialHosts({
		db,
		orgId,
		credentialId: 'cred-github',
		hosts: [],
		audit,
	})
	const row = sqlite
		.prepare(
			`SELECT required_hosts_json FROM user_integrations WHERE id = 'cred-github'`,
		)
		.get() as { required_hosts_json: string }
	expect(JSON.parse(row.required_hosts_json)).toEqual(['api.github.com'])
})

test('a Key replaces its hosts and must keep at least one', async () => {
	const { sqlite, db, auditDb, audit } = setup()
	await expect(
		updateCredentialHosts({
			db,
			orgId,
			credentialId: 'cred-key',
			hosts: [],
			audit,
		}),
	).rejects.toThrow('Keep at least one host.')

	await updateCredentialHosts({
		db,
		orgId,
		credentialId: 'cred-key',
		hosts: ['api.openai.com', 'eu.api.openai.com'],
		audit,
	})
	const row = sqlite
		.prepare(
			`SELECT allowed_hosts, encrypted_value FROM secret_entries WHERE id = 'cred-key'`,
		)
		.get() as { allowed_hosts: string; encrypted_value: string }
	expect(JSON.parse(row.allowed_hosts)).toEqual([
		'api.openai.com',
		'eu.api.openai.com',
	])
	expect(row.encrypted_value).toBe('ct-key')
	expect((await readAuditRows(auditDb)).map((r) => r.action)).toEqual([
		'credential.hosts_updated',
	])
})

test('an unchanged list writes and audits nothing', async () => {
	const { sqlite, db, auditDb, audit } = setup()
	const before = sqlite
		.prepare(`SELECT updated_at FROM secret_entries WHERE id = 'cred-key'`)
		.get()
	expect(
		await updateCredentialHosts({
			db,
			orgId,
			credentialId: 'cred-key',
			hosts: ['api.openai.com'],
			audit,
		}),
	).toEqual({ hosts: ['api.openai.com'], fixedHosts: [], changed: false })
	expect(
		sqlite
			.prepare(`SELECT updated_at FROM secret_entries WHERE id = 'cred-key'`)
			.get(),
	).toEqual(before)
	expect(await readAuditRows(auditDb)).toEqual([])
})

test('URL credentials, other orgs, and unknown ids are refused', async () => {
	const { db, auditDb, audit } = setup()
	expect(
		await readCredentialHostSettings({
			db,
			orgId,
			credential: await credential(db, 'cred-url'),
		}),
	).toBeNull()
	await expect(
		updateCredentialHosts({
			db,
			orgId,
			credentialId: 'cred-url',
			hosts: ['evil.example.com'],
			audit,
		}),
	).rejects.toThrow('take their hosts with their value')
	for (const id of ['cred-other-org', 'cred-missing']) {
		await expect(
			updateCredentialHosts({
				db,
				orgId,
				credentialId: id,
				hosts: ['evil.example.com'],
				audit,
			}),
		).rejects.toThrow('No credential with that id in this org.')
	}
	expect(await readAuditRows(auditDb)).toEqual([])
})
