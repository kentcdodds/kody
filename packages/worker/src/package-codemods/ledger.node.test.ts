import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	createPackageCodemodRun,
	getPackageCodemodRunById,
	getPackageCodemodRunItemById,
	insertPackageCodemodRunItem,
	listPackageCodemodRunItems,
	listPackageCodemodRuns,
	updatePackageCodemodRunStatus,
} from './ledger.ts'

function createLedgerDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL(
				'../../migrations/0111-package-codemod-ledger.sql',
				import.meta.url,
			),
			'utf8',
		),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

test('package codemod ledger pages runs and items with filters', async () => {
	const { db } = createLedgerDb()

	await createPackageCodemodRun(db, {
		id: 'run-a',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'scan',
		scopeUserId: 'user-1',
		initiatedByUserId: 'admin-1',
		createdAt: '2026-07-30T10:00:00.000Z',
		updatedAt: '2026-07-30T10:00:00.000Z',
	})
	await createPackageCodemodRun(db, {
		id: 'run-b',
		codemodId: '0001-ambient-storage-to-package-storage',
		mode: 'apply',
		scopeUserId: null,
		initiatedByUserId: 'admin-1',
		createdAt: '2026-07-30T11:00:00.000Z',
		updatedAt: '2026-07-30T11:00:00.000Z',
	})
	await createPackageCodemodRun(db, {
		id: 'run-c',
		codemodId: '0002-other',
		mode: 'scan',
		scopeUserId: 'user-2',
		initiatedByUserId: 'admin-1',
		createdAt: '2026-07-30T12:00:00.000Z',
		updatedAt: '2026-07-30T12:00:00.000Z',
	})

	const byCodemod = await listPackageCodemodRuns(db, {
		codemodId: '0001-ambient-storage-to-package-storage',
		limit: 10,
	})
	expect(byCodemod.map((run) => run.id)).toEqual(['run-b', 'run-a'])

	const fleetOnly = await listPackageCodemodRuns(db, {
		scopeUserId: null,
		limit: 10,
	})
	expect(fleetOnly.map((run) => run.id)).toEqual(['run-b'])

	const userScoped = await listPackageCodemodRuns(db, {
		scopeUserId: 'user-1',
		limit: 10,
	})
	expect(userScoped.map((run) => run.id)).toEqual(['run-a'])

	await updatePackageCodemodRunStatus(db, {
		id: 'run-a',
		status: 'completed',
	})
	expect(await getPackageCodemodRunById(db, 'run-a')).toMatchObject({
		id: 'run-a',
		status: 'completed',
	})

	await insertPackageCodemodRunItem(db, {
		id: 'item-1',
		runId: 'run-b',
		userId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'one',
		status: 'applied',
		beforeCommit: 'c1',
		afterCommit: 'c2',
		changedPaths: ['index.ts'],
		findings: [{ path: 'index.ts', message: 'note' }],
		revertSnapshotKey: 'package-codemod-revert:user-1:item-1',
	})
	await insertPackageCodemodRunItem(db, {
		id: 'item-2',
		runId: 'run-b',
		userId: 'user-2',
		packageId: 'pkg-2',
		kodyId: 'two',
		status: 'clean',
	})
	await insertPackageCodemodRunItem(db, {
		id: 'item-3',
		runId: 'run-b',
		userId: 'user-3',
		packageId: 'pkg-3',
		kodyId: 'three',
		status: 'applied',
	})

	const firstPage = await listPackageCodemodRunItems(db, {
		runId: 'run-b',
		limit: 2,
	})
	expect(firstPage.map((item) => item.id)).toEqual(['item-1', 'item-2'])
	expect(firstPage[0]).toMatchObject({
		changedPaths: ['index.ts'],
		findings: [{ path: 'index.ts', message: 'note' }],
		beforeCommit: 'c1',
		afterCommit: 'c2',
		revertSnapshotKey: 'package-codemod-revert:user-1:item-1',
	})

	const secondPage = await listPackageCodemodRunItems(db, {
		runId: 'run-b',
		afterId: 'item-2',
		limit: 2,
	})
	expect(secondPage.map((item) => item.id)).toEqual(['item-3'])

	const appliedOnly = await listPackageCodemodRunItems(db, {
		runId: 'run-b',
		status: 'applied',
		limit: 10,
	})
	expect(appliedOnly.map((item) => item.id)).toEqual(['item-1', 'item-3'])

	const user1Items = await listPackageCodemodRunItems(db, {
		runId: 'run-b',
		userId: 'user-1',
		limit: 10,
	})
	expect(user1Items.map((item) => item.id)).toEqual(['item-1'])

	const user1AppliedPage = await listPackageCodemodRunItems(db, {
		runId: 'run-b',
		userId: 'user-1',
		status: 'applied',
		limit: 10,
	})
	expect(user1AppliedPage.map((item) => item.id)).toEqual(['item-1'])

	expect(
		await getPackageCodemodRunById(db, 'run-a', { userId: 'user-1' }),
	).toMatchObject({ id: 'run-a' })
	expect(
		await getPackageCodemodRunById(db, 'run-a', { userId: 'user-2' }),
	).toBeNull()
	expect(
		await getPackageCodemodRunById(db, 'run-b', { userId: 'user-1' }),
	).toBeNull()

	expect(
		await getPackageCodemodRunItemById(db, 'item-1', { userId: 'user-1' }),
	).toMatchObject({ id: 'item-1' })
	expect(
		await getPackageCodemodRunItemById(db, 'item-1', { userId: 'user-2' }),
	).toBeNull()
})
