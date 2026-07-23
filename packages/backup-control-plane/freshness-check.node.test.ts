import assert from 'node:assert/strict'

import { test, vi } from 'vitest'

import { DEFAULT_BACKUP_MAX_SOURCE_BYTES } from './d1-export-api.ts'
import { checkFreshness } from './freshness-check.ts'
import {
	MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES,
	putImmutableManifest,
	storeSignedDownload,
} from './immutable-storage.ts'
import { BackupError, objectKeyForBookmark } from './backup-policy.ts'
import {
	DATABASE_ID,
	MemoryBucket,
	environment,
	identityApi,
	identityEnvelope,
	manifest,
} from './backup-control-plane-test-support.ts'

test('freshness accepts matching metadata and flags size/ETag drift or missing objects', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const key = objectKeyForBookmark(
		`daily/d1/${DATABASE_ID}/2026-07-22`,
		'bookmark-1',
	)
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		key,
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		`daily/d1/${DATABASE_ID}/2026-07-22/manifest.json`,
		manifest(stored),
	)
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), identityApi()),
		true,
	)
	bucket.setReportedSize(key, MAXIMUM_SINGLE_BACKUP_OBJECT_BYTES)
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), identityApi()),
		false,
	)
	bucket.setReportedSize(key, stored.bytes)
	bucket.corrupt(key, 'drift')
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), identityApi()),
		false,
	)
	bucket.corrupt(key, 'longer')
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), identityApi()),
		false,
	)
	assert.equal(
		await checkFreshness(
			environment(new MemoryBucket()),
			new Date('2026-07-22T03:45:00Z'),
			identityApi(),
		),
		false,
	)
})

test('freshness switches from yesterday to today at the 02:15 backup boundary', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	const previousKey = objectKeyForBookmark(
		`daily/d1/${DATABASE_ID}/2026-07-21`,
		'bookmark-1',
	)
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		previousKey,
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		`daily/d1/${DATABASE_ID}/2026-07-21/manifest.json`,
		{
			...manifest(stored),
			scheduledAt: '2026-07-21T02:15:00.000Z',
			startedAt: '2026-07-21T02:15:01.000Z',
			completedAt: '2026-07-21T02:16:00.000Z',
			objectKey: previousKey,
		},
	)
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T01:45:00Z'), identityApi()),
		true,
	)
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T02:45:00Z'), identityApi()),
		false,
	)
})

test('freshness reports malformed manifest schema as stale', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	await bucket.put(
		`daily/d1/${DATABASE_ID}/2026-07-22/manifest.json`,
		JSON.stringify({ schemaVersion: 1 }),
	)
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), identityApi()),
		false,
	)
})

test('freshness compares Cloudflare account and D1 IDs case-insensitively', async () => {
	const bucket = new MemoryBucket()
	const env = environment(bucket)
	env.SOURCE_ACCOUNT_ID = 'abcdefabcdefabcdefabcdefabcdefab'
	env.ALLOWED_SOURCE_ACCOUNT_IDS = env.SOURCE_ACCOUNT_ID.toUpperCase()
	env.SOURCE_DATABASE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
	env.ALLOWED_SOURCE_DATABASE_IDS = env.SOURCE_DATABASE_ID.toUpperCase()
	const key = objectKeyForBookmark(
		`daily/d1/${env.SOURCE_DATABASE_ID}/2026-07-22`,
		'bookmark-1',
	)
	const stored = await storeSignedDownload(
		bucket as unknown as R2Bucket,
		key,
		'https://download.example',
		async () => new Response('valid', { headers: { 'content-length': '5' } }),
	)
	await putImmutableManifest(
		bucket as unknown as R2Bucket,
		`daily/d1/${env.SOURCE_DATABASE_ID}/2026-07-22/manifest.json`,
		{
			...manifest(stored),
			source: {
				accountId: env.SOURCE_ACCOUNT_ID.toUpperCase(),
				accountName: env.SOURCE_ACCOUNT_NAME,
				databaseId: env.SOURCE_DATABASE_ID.toUpperCase(),
				databaseName: env.SOURCE_DATABASE_NAME,
			},
			objectKey: key,
		},
	)
	assert.equal(
		await checkFreshness(env, new Date('2026-07-22T03:45:00Z'), {
			fetcher: async () =>
				Response.json({
					success: true,
					result: {
						uuid: env.SOURCE_DATABASE_ID.toUpperCase(),
						name: env.SOURCE_DATABASE_NAME,
						file_size: 1_000,
					},
				}),
			sleep: async () => undefined,
		}),
		true,
	)
})

test('hourly freshness queries live D1 size and fails at the ceiling', async () => {
	const consoleError = vi.spyOn(console, 'error')
	consoleError.mockClear()
	consoleError.mockImplementation(() => undefined)
	let metadataRequests = 0
	await assert.rejects(
		checkFreshness(environment(), new Date('2026-07-22T03:45:00Z'), {
			fetcher: async () => {
				metadataRequests += 1
				return identityEnvelope(DEFAULT_BACKUP_MAX_SOURCE_BYTES)
			},
		}),
		(error: unknown) =>
			error instanceof BackupError &&
			error.code === 'source-size-limit-exceeded',
	)
	assert.equal(metadataRequests, 1)
	assert.equal(consoleError.mock.calls.length, 1)
})
