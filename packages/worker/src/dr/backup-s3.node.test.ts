import { expect, test, vi } from 'vitest'
import {
	createDrBackupS3Client,
	DrBackupPreconditionFailedError,
	isTransientDrBackupHttpStatus,
	readDrBackupS3Config,
} from './backup-s3.ts'

const config = {
	accountId: 'acct',
	bucketName: 'backups',
	accessKeyId: 'key',
	secretAccessKey: 'secret',
}

function jsonResponse(
	status: number,
	body = '',
	headers: Record<string, string> = {},
) {
	return new Response(body, { status, headers })
}

test('DR backup S3 client retries transient failures and fails closed otherwise', async () => {
	expect(isTransientDrBackupHttpStatus(429)).toBe(true)
	expect(isTransientDrBackupHttpStatus(500)).toBe(true)
	expect(isTransientDrBackupHttpStatus(503)).toBe(true)
	expect(isTransientDrBackupHttpStatus(400)).toBe(false)
	expect(isTransientDrBackupHttpStatus(412)).toBe(false)

	expect(
		readDrBackupS3Config({
			DR_BACKUP_ACCOUNT_ID: 'a',
			DR_BACKUP_BUCKET_NAME: 'b',
			DR_BACKUP_ACCESS_KEY_ID: 'c',
			DR_BACKUP_SECRET_ACCESS_KEY: 'd',
		}),
	).toEqual({
		accountId: 'a',
		bucketName: 'b',
		accessKeyId: 'c',
		secretAccessKey: 'd',
	})
	expect(
		readDrBackupS3Config({
			DR_BACKUP_ACCOUNT_ID: 'a',
			DR_BACKUP_BUCKET_NAME: '',
			DR_BACKUP_ACCESS_KEY_ID: 'c',
			DR_BACKUP_SECRET_ACCESS_KEY: 'd',
		}),
	).toBeNull()

	const putFetch = vi
		.fn()
		.mockResolvedValueOnce(jsonResponse(500, 'blip'))
		.mockResolvedValueOnce(jsonResponse(200, '', { etag: '"etag-1"' }))
	const putClient = createDrBackupS3Client(config, putFetch as typeof fetch, {
		maxAttempts: 3,
		baseDelayMs: 1,
	})
	await expect(
		putClient.put('staging/day/exporter/progress.json', '{}', {
			contentType: 'application/json',
			ifMatch: '"prev"',
		}),
	).resolves.toEqual({ etag: '"etag-1"' })
	expect(putFetch).toHaveBeenCalledTimes(2)

	const preconditionFetch = vi
		.fn()
		.mockResolvedValue(jsonResponse(412, 'conflict'))
	const preconditionClient = createDrBackupS3Client(
		config,
		preconditionFetch as typeof fetch,
		{ maxAttempts: 4, baseDelayMs: 1 },
	)
	await expect(
		preconditionClient.put('staging/day/exporter/progress.json', '{}', {
			ifMatch: '"prev"',
		}),
	).rejects.toBeInstanceOf(DrBackupPreconditionFailedError)
	expect(preconditionFetch).toHaveBeenCalledTimes(1)

	const exhaustedFetch = vi
		.fn()
		.mockRejectedValueOnce(new TypeError('network down'))
		.mockResolvedValueOnce(jsonResponse(500, 'still bad'))
		.mockResolvedValueOnce(jsonResponse(500, 'still bad'))
	const exhaustedClient = createDrBackupS3Client(
		config,
		exhaustedFetch as typeof fetch,
		{ maxAttempts: 3, baseDelayMs: 1 },
	)
	await expect(exhaustedClient.put('key', 'body')).rejects.toThrow(
		'DR backup PUT failed for key: HTTP 500',
	)
	expect(exhaustedFetch).toHaveBeenCalledTimes(3)

	const headFetch = vi
		.fn()
		.mockResolvedValueOnce(jsonResponse(503))
		.mockResolvedValueOnce(jsonResponse(200, '', { etag: '"h"' }))
	const headClient = createDrBackupS3Client(config, headFetch as typeof fetch, {
		maxAttempts: 2,
		baseDelayMs: 1,
	})
	await expect(headClient.head('blob')).resolves.toEqual({
		exists: true,
		status: 200,
		etag: '"h"',
	})

	const getFetch = vi
		.fn()
		.mockResolvedValueOnce(jsonResponse(503, 'busy'))
		.mockResolvedValueOnce(jsonResponse(200, '{"ok":true}', { etag: '"g"' }))
	const getClient = createDrBackupS3Client(config, getFetch as typeof fetch, {
		maxAttempts: 2,
		baseDelayMs: 1,
	})
	await expect(getClient.getText('progress.json')).resolves.toEqual({
		text: '{"ok":true}',
		etag: '"g"',
	})

	const bytesFetch = vi
		.fn()
		.mockResolvedValueOnce(jsonResponse(503, 'busy'))
		.mockResolvedValueOnce(jsonResponse(200, 'abc', { etag: '"b"' }))
	const bytesClient = createDrBackupS3Client(
		config,
		bytesFetch as typeof fetch,
		{ maxAttempts: 2, baseDelayMs: 1 },
	)
	await expect(bytesClient.getBytes('blob.bin')).resolves.toEqual(
		new Uint8Array([97, 98, 99]),
	)
})
