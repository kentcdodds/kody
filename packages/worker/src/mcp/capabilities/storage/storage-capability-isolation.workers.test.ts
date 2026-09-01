import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { clearStorageBucketRegistrationDedupeForTests } from '#worker/storage-buckets/service.ts'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import { storageRunnerRpc } from '#worker/storage-runner.ts'
import { storageExportCapability } from './storage-export.ts'
import { storageQueryCapability } from './storage-query.ts'

function createPackageCallerContext(input: {
	userId: string
	packageId: string
}) {
	return createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: input.userId,
			email: 'worker@example.com',
			displayName: 'Worker',
		},
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			packageId: input.packageId,
			storageId: buildPackageStorageId(input.packageId),
		},
	})
}

test('storage capabilities keep a package out of another package bucket', async () => {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureUserStorageBucketsTestSchema(env.APP_DB)
	clearStorageBucketRegistrationDedupeForTests()

	const userId = `user-${crypto.randomUUID()}`
	const victimPackageId = crypto.randomUUID()
	const attackerPackageId = crypto.randomUUID()
	const victimBucket = buildPackageStorageId(victimPackageId)
	const victimRunner = storageRunnerRpc({
		env,
		userId,
		storageId: victimBucket,
	})

	await victimRunner.setValue({ key: 'token', value: 'do-not-leak' })
	await victimRunner.sqlQuery({
		query: 'create table if not exists secrets (name text)',
		writable: true,
	})
	await victimRunner.sqlQuery({
		query: "insert into secrets values ('do-not-leak')",
		writable: true,
	})

	const callerContext = createPackageCallerContext({
		userId,
		packageId: attackerPackageId,
	})
	const ctx = { env, callerContext } as never

	await expect(
		storageExportCapability.handler({ storage_id: victimBucket }, ctx),
	).rejects.toThrow(McpCallerError)
	await expect(
		storageQueryCapability.handler(
			{ storage_id: victimBucket, query: 'select name from secrets' },
			ctx,
		),
	).rejects.toThrow(McpCallerError)
	await expect(
		storageQueryCapability.handler(
			{
				storage_id: victimBucket,
				query: 'delete from secrets',
				writable: true,
			},
			ctx,
		),
	).rejects.toThrow(McpCallerError)

	// The victim bucket is untouched by the denied calls.
	await expect(
		victimRunner.sqlQuery({ query: 'select count(*) as rows from secrets' }),
	).resolves.toMatchObject({ rows: [{ rows: 1 }] })

	// The caller still reaches its own bucket by id.
	const ownBucket = buildPackageStorageId(attackerPackageId)
	await storageRunnerRpc({ env, userId, storageId: ownBucket }).setValue({
		key: 'mine',
		value: 'ok',
	})
	await expect(
		storageExportCapability.handler({ storage_id: ownBucket }, ctx),
	).resolves.toMatchObject({
		storage_id: ownBucket,
		export: { entries: [{ key: 'mine', value: 'ok' }] },
	})
})
