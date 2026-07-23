import { expect, test, vi } from 'vitest'
import {
	buildEscrowSecretStoreKey,
	main,
	putSealedEscrowBlob,
	sealEscrowSecret,
	unsealEscrowSecretForTests,
} from './seal-escrow.ts'
import {
	backupEscrowSecretStoreKeyKey,
	parseSealedEscrowBlob,
} from '@kody-internal/shared/backup-staging.ts'

test('sealEscrowSecret round-trips through unseal helper', () => {
	const sealed = sealEscrowSecret({
		secretValue: 'super-secret-value-32-chars-minimum!!',
		passphrase: 'operator-passphrase',
		label: 'secret-store-key',
		sealedAt: '2026-07-23T01:02:03.000Z',
	})
	expect(sealed.iterations).toBeGreaterThanOrEqual(600_000)
	expect(parseSealedEscrowBlob(sealed).label).toBe('secret-store-key')
	expect(unsealEscrowSecretForTests(sealed, 'operator-passphrase')).toBe(
		'super-secret-value-32-chars-minimum!!',
	)
	expect(() => unsealEscrowSecretForTests(sealed, 'wrong-passphrase')).toThrow()
})

test('putSealedEscrowBlob signs and uploads without logging secrets', async () => {
	const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
	await putSealedEscrowBlob({
		accountId: 'a'.repeat(32),
		bucketName: 'kody-dr-backups',
		accessKeyId: 'AKIA_TEST',
		secretAccessKey: 'secret',
		body: JSON.stringify({ ok: true }),
		fetchImpl: fetchImpl as unknown as typeof fetch,
	})
	expect(fetchImpl).toHaveBeenCalledTimes(1)
	const [url, init] = fetchImpl.mock.calls[0]!
	expect(String(url)).toContain('escrow')
	const headers = new Headers((init as RequestInit).headers)
	expect(headers.get('Authorization')).toContain('AWS4-HMAC-SHA256')
})

test('main seals and uploads using env vars without printing secret material', async () => {
	const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
	const originalFetch = globalThis.fetch
	globalThis.fetch = fetchImpl as unknown as typeof fetch
	const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
	try {
		await main({
			ESCROW_SECRET_VALUE: 'secret-value-for-escrow-test-32chars',
			ESCROW_PASSPHRASE: 'passphrase',
			ESCROW_LABEL: 'secret-store-key',
			DR_BACKUP_ACCOUNT_ID: 'a'.repeat(32),
			DR_BACKUP_BUCKET_NAME: 'kody-dr-backups',
			DR_BACKUP_ACCESS_KEY_ID: 'AKIA_TEST',
			DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		})
		expect(fetchImpl).toHaveBeenCalled()
		const logged = logSpy.mock.calls.map((call) => call.join(' ')).join('\n')
		expect(logged).not.toContain('secret-value-for-escrow-test-32chars')
		expect(logged).not.toContain('passphrase')
		expect(logged).toContain(backupEscrowSecretStoreKeyKey)
	} finally {
		globalThis.fetch = originalFetch
		logSpy.mockRestore()
	}
})

test('buildEscrowSecretStoreKey defaults to the shared contract v1 key', () => {
	expect(buildEscrowSecretStoreKey()).toBe(backupEscrowSecretStoreKeyKey)
	expect(buildEscrowSecretStoreKey('v2')).toBe(
		'escrow/secret-store-key.v2.json',
	)
})

test('putSealedEscrowBlob explains write-once lock rejections clearly', async () => {
	const fetchImpl = vi.fn(
		async () =>
			new Response('ObjectLocked', {
				status: 409,
			}),
	)
	await expect(
		putSealedEscrowBlob({
			accountId: 'a'.repeat(32),
			bucketName: 'kody-dr-backups',
			accessKeyId: 'AKIA_TEST',
			secretAccessKey: 'secret',
			body: JSON.stringify({ ok: true }),
			objectKey: backupEscrowSecretStoreKeyKey,
			fetchImpl: fetchImpl as unknown as typeof fetch,
		}),
	).rejects.toThrow(/write-once|ESCROW_KEY_VERSION|v2/)
})

test('main uses ESCROW_KEY_VERSION for rotation keys', async () => {
	const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }))
	const originalFetch = globalThis.fetch
	globalThis.fetch = fetchImpl as unknown as typeof fetch
	const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
	try {
		await main({
			ESCROW_SECRET_VALUE: 'secret-value-for-escrow-test-32chars',
			ESCROW_PASSPHRASE: 'passphrase',
			ESCROW_LABEL: 'secret-store-key',
			ESCROW_KEY_VERSION: 'v2',
			DR_BACKUP_ACCOUNT_ID: 'a'.repeat(32),
			DR_BACKUP_BUCKET_NAME: 'kody-dr-backups',
			DR_BACKUP_ACCESS_KEY_ID: 'AKIA_TEST',
			DR_BACKUP_SECRET_ACCESS_KEY: 'secret',
		})
		const [url] = fetchImpl.mock.calls[0]!
		expect(String(url)).toContain('secret-store-key.v2.json')
		expect(logSpy.mock.calls.join(' ')).toContain(
			'escrow/secret-store-key.v2.json',
		)
	} finally {
		globalThis.fetch = originalFetch
		logSpy.mockRestore()
	}
})
