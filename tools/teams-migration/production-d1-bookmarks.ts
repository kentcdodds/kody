/**
 * Read-only D1 Time Travel bookmarks, sealed to the operator's public key.
 * Take immediately before the Teams P9 contract deploy.
 *
 * Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
 *
 * Usage:
 *   node tools/teams-migration/production-d1-bookmarks.ts \
 *     --target production \
 *     --recipient-public-key <base64 SPKI> \
 *     --out bookmarks.sealed.json
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
	getD1Bookmark,
	resolveRehearsalDatabases,
	type CloudflareClient,
} from '../preview-rehearsal/d1-rehearsal.ts'
import {
	importRecipientPublicKey,
	sealJson,
} from '../preview-rehearsal/seal.ts'
import { fail, listD1Databases } from '../ci/resource-utils.ts'
import { isExecutedDirectly } from '../node-runtime.ts'

type Role = 'app' | 'audit' | 'jobs'

const productionDatabases: ReadonlyArray<{
	role: Role
	binding: string
	name: string
}> = [
	{ role: 'app', binding: 'APP_DB', name: 'kody' },
	{ role: 'audit', binding: 'AUDIT_DB', name: 'kody-audit' },
	{ role: 'jobs', binding: 'JOBS_DB', name: 'kody-jobs' },
]

function requireEnv(name: string) {
	const value = process.env[name]?.trim()
	if (!value) fail(`Missing ${name}.`)
	return value
}

function readFlag(argv: ReadonlyArray<string>, flag: string) {
	const index = argv.indexOf(flag)
	const value = index === -1 ? undefined : argv[index + 1]
	if (!value) fail(`Missing ${flag} <value>.`)
	return value
}

function resolveUuidByName(name: string) {
	const match = listD1Databases().find((db) => db.name === name)
	if (!match?.uuid) {
		fail(`Cloudflare account has no D1 database named "${name}".`)
	}
	return match.uuid
}

export async function takeSealedD1Bookmarks(input: {
	target: string
	recipientPublicKey: string
}) {
	const client: CloudflareClient = {
		accountId: requireEnv('CLOUDFLARE_ACCOUNT_ID'),
		apiToken: requireEnv('CLOUDFLARE_API_TOKEN'),
	}

	const databases =
		input.target === 'production'
			? productionDatabases.map((database) => ({
					...database,
					uuid: resolveUuidByName(database.name),
				}))
			: (await resolveRehearsalDatabases(client, input.target)).map((db) => ({
					role: db.role,
					binding:
						db.role === 'app'
							? 'APP_DB'
							: db.role === 'audit'
								? 'AUDIT_DB'
								: 'JOBS_DB',
					name: db.name,
					uuid: db.uuid,
				}))

	const snapshots = []
	for (const database of databases) {
		const bookmark = await getD1Bookmark(client, database.uuid)
		snapshots.push({ ...database, bookmark })
	}

	const report = {
		version: 1 as const,
		kind: 'teams-p9-pre-migration-d1-bookmarks',
		target: input.target,
		takenAt: new Date().toISOString(),
		databases: snapshots,
	}
	const publicKey = await importRecipientPublicKey(input.recipientPublicKey)
	return { report, sealed: await sealJson(report, publicKey) }
}

const usage = [
	'Usage: node tools/teams-migration/production-d1-bookmarks.ts --target <production|kody-branch-*> --recipient-public-key <base64 SPKI> --out <bookmarks.sealed.json>',
].join('\n')

if (isExecutedDirectly(import.meta.url)) {
	const argv = process.argv.slice(2)
	const target = readFlag(argv, '--target')
	const recipientPublicKey = readFlag(argv, '--recipient-public-key')
	const outPath = resolve(readFlag(argv, '--out'))
	if (
		target !== 'production' &&
		!/^kody-branch-[a-z0-9]+(-[a-z0-9]+)*$/.test(target)
	) {
		fail(`Invalid --target ${target}.\n${usage}`)
	}
	const { report, sealed } = await takeSealedD1Bookmarks({
		target,
		recipientPublicKey,
	})
	await writeFile(outPath, `${JSON.stringify(sealed, null, 2)}\n`, {
		mode: 0o600,
	})
	console.log(
		`Wrote sealed D1 bookmarks for ${report.databases.length} database(s) to ${outPath}.`,
	)
	console.log(
		`Open with: node tools/preview-rehearsal/seal.ts open --private-key <key> --in ${outPath} --out bookmarks.json`,
	)
}
