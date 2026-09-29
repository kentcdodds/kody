import {
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { main, putSealedEscrowBlob, sealEscrowSecret } from './seal-escrow.ts'
import { main as unsealMain, unsealEscrowSecret } from './unseal-escrow.ts'
import {
	backupEscrowSecretStoreKeyKey,
	parseSealedEscrowBlob,
} from '@kody-internal/shared/backup-staging.ts'

function unseal(passphrase: string, input: string, output: string) {
	return unsealMain({ SECRET_ESCROW_PASSPHRASE: passphrase }, [
		'--input',
		input,
		'--output',
		output,
	])
}

async function runSealMain(extraEnv: Record<string, string> = {}) {
	const fetchImpl = vi.fn(
		async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(null, { status: 200 }),
	)
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
			...extraEnv,
		})
		const [url, init] = fetchImpl.mock.calls[0] ?? []
		return {
			url: String(url),
			headers: new Headers(init?.headers),
			logged: logSpy.mock.calls.map((call) => call.join(' ')).join('\n'),
		}
	} finally {
		globalThis.fetch = originalFetch
		logSpy.mockRestore()
	}
}

test('the operator unseal tool round-trips sealed key bytes and fails closed', async () => {
	const secretValue = 'known-test-secret-store-key-\u0000-\u{1f512}'
	const passphrase = 'test-only-operator-passphrase'
	const sealed = sealEscrowSecret({
		secretValue,
		passphrase,
		label: 'secret-store-key',
		sealedAt: '2026-07-23T01:02:03.000Z',
	})
	expect(sealed.iterations).toBeGreaterThanOrEqual(600_000)
	expect(parseSealedEscrowBlob(sealed).label).toBe('secret-store-key')
	expect(
		Buffer.from(unsealEscrowSecret(sealed, passphrase), 'utf8').equals(
			Buffer.from(secretValue, 'utf8'),
		),
	).toBe(true)
	expect(() => unsealEscrowSecret(sealed, 'wrong-passphrase')).toThrow(
		/authentication failed/,
	)

	const directory = await mkdtemp(path.join(tmpdir(), 'kody-escrow-unseal-'))
	try {
		const inputPath = path.join(directory, 'secret-store-key.v1.json')
		const outputPath = path.join(directory, 'recovered-secret')
		await writeFile(inputPath, JSON.stringify(sealed), 'utf8')

		await expect(
			unseal('wrong-passphrase', inputPath, outputPath),
		).rejects.toThrow(/authentication failed/)
		await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })

		await unseal(passphrase, inputPath, outputPath)
		expect(await readFile(outputPath, 'utf8')).toBe(secretValue)
		expect((await stat(outputPath)).mode & 0o777).toBe(0o600)
		await expect(
			unseal(passphrase, inputPath, outputPath),
		).rejects.toMatchObject({ code: 'EEXIST' })
		expect(await readFile(outputPath, 'utf8')).toBe(secretValue)

		const mismatchedPath = path.join(directory, 'mismatched.json')
		const mismatchedOutputPath = path.join(directory, 'mismatched-output')
		await writeFile(
			mismatchedPath,
			JSON.stringify({ ...sealed, schemaVersion: 2 }),
			'utf8',
		)
		await expect(
			unseal(passphrase, mismatchedPath, mismatchedOutputPath),
		).rejects.toThrow(/invalid versioned shape/)
		await expect(stat(mismatchedOutputPath)).rejects.toMatchObject({
			code: 'ENOENT',
		})

		const repositoryLink = path.join(directory, 'repository-link')
		await symlink(process.cwd(), repositoryLink, 'dir')
		await expect(
			unseal(
				passphrase,
				inputPath,
				path.join(repositoryLink, 'recovered-secret'),
			),
		).rejects.toThrow(/inside the repository/)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('main seals and uploads the default escrow key without printing secret material', async () => {
	const upload = await runSealMain()
	expect(upload.url).toContain(backupEscrowSecretStoreKeyKey)
	expect(upload.headers.get('Authorization')).toContain('AWS4-HMAC-SHA256')
	expect(upload.logged).not.toContain('secret-value-for-escrow-test-32chars')
	expect(upload.logged).not.toContain('passphrase')
	expect(upload.logged).toContain(backupEscrowSecretStoreKeyKey)
})

test('escrow rotation uses versioned keys and write-once rejections throw', async () => {
	const rotated = await runSealMain({ ESCROW_KEY_VERSION: 'v2' })
	expect(rotated.url).toContain('secret-store-key.v2.json')
	expect(rotated.logged).toContain('escrow/secret-store-key.v2.json')

	const lockedFetchImpl = vi.fn(
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
			fetchImpl: lockedFetchImpl as unknown as typeof fetch,
		}),
	).rejects.toThrow(/write-once|409|ObjectLocked/)
})
