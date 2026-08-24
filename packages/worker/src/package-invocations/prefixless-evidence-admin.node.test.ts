import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { packageInvokePrefixlessEvidenceEpoch } from '#universal/package-invoke-prefixless-evidence.ts'
import {
	loadPackageInvokePrefixlessEvidenceAggregate,
	packageInvokeEvidenceAdminPageSize,
} from './prefixless-evidence-admin.ts'

test('admin evidence aggregates paged UserMeters without identifiers and marks accounting gaps incomplete', async () => {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT,
			deleting_at TEXT
		)
	`)
	const insert = sqlite.prepare(
		`INSERT INTO users (id, stable_user_id, deleting_at) VALUES (?, ?, ?)`,
	)
	for (
		let index = 1;
		index <= packageInvokeEvidenceAdminPageSize + 1;
		index++
	) {
		insert.run(index, `private-user-${index}`, null)
	}
	insert.run(1000, 'deleting-private-user', '2026-08-24T00:00:00.000Z')

	const namespace = {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			async readPackageInvokePrefixless() {
				if (id.name.includes('private-user-50')) {
					return {
						outcome: 'epoch_missing' as const,
						epoch: packageInvokePrefixlessEvidenceEpoch,
					}
				}
				if (id.name.includes('private-user-51')) {
					throw new Error('unreachable')
				}
				return {
					outcome: 'ready' as const,
					epoch: packageInvokePrefixlessEvidenceEpoch,
					counts: { execute: 1, package: 2, job: 3, app: 4 },
				}
			},
		}),
	} as unknown as DurableObjectNamespace

	const result = await loadPackageInvokePrefixlessEvidenceAggregate({
		APP_DB: createD1FromSqlite(sqlite),
		USER_METER: namespace,
	})

	expect(result).toEqual({
		epoch: packageInvokePrefixlessEvidenceEpoch,
		totals: { execute: 49, package: 98, job: 147, app: 196 },
		population: {
			usersExpected: 51,
			usersEnumerated: 51,
			usersAttempted: 51,
			usersLoaded: 49,
			usersMissingEpoch: 1,
			usersUnreachable: 1,
			pagesScanned: 2,
			complete: false,
		},
	})
	expect(JSON.stringify(result)).not.toContain('private-user')
})
