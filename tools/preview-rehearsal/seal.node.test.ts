import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	generateSealKeyPair,
	importRecipientPublicKey,
	openSealedJson,
	privateKeyWrittenMessage,
	publicKeyWrittenMessage,
	recipientPublicKeyPath,
	sealJson,
	writeSealKeyPair,
} from './seal.ts'

test('a sealed envelope opens only with the matching private key and carries no plaintext', async () => {
	const recipient = await generateSealKeyPair()
	const other = await generateSealKeyPair()
	const secret = { admin: { email: 'a@example.com', password: 'p4ssw0rd-xyz' } }

	const envelope = await sealJson(
		secret,
		await importRecipientPublicKey(recipient.publicKey),
	)
	expect(JSON.stringify(envelope)).not.toContain('p4ssw0rd-xyz')
	await expect(openSealedJson(envelope, recipient.privateKey)).resolves.toEqual(
		secret,
	)
	await expect(openSealedJson(envelope, other.privateKey)).rejects.toThrow(
		'Could not open the sealed envelope',
	)
	await expect(
		openSealedJson(
			{ ...envelope, ciphertext: Buffer.from('tampered').toString('base64') },
			recipient.privateKey,
		),
	).rejects.toThrow('Could not open the sealed envelope')
})

test('importRecipientPublicKey rejects a key that is not base64 SPKI RSA', async () => {
	await expect(importRecipientPublicKey('not-a-key')).rejects.toThrow(
		'recipient public key is not a base64 SPKI RSA key',
	)
})

test('importRecipientPublicKey accepts keygen stderr banner plus the printed public key', async () => {
	const recipient = await generateSealKeyPair()
	const privateKeyPath = '/home/ubuntu/.kody-rehearsal/key'
	const spaced = `${recipient.publicKey.slice(0, 32)} ${recipient.publicKey.slice(32, 64)}\n${recipient.publicKey.slice(64)}`
	const pastes = [
		`${privateKeyWrittenMessage(privateKeyPath)}\n${recipient.publicKey}`,
		[
			privateKeyWrittenMessage(privateKeyPath),
			publicKeyWrittenMessage(recipientPublicKeyPath(privateKeyPath)),
			recipient.publicKey,
		].join('\n'),
		`${privateKeyWrittenMessage(privateKeyPath)}\n${spaced}`,
	]
	for (const noisy of pastes) {
		const envelope = await sealJson(
			{ ok: true },
			await importRecipientPublicKey(noisy),
		)
		await expect(
			openSealedJson(envelope, recipient.privateKey),
		).resolves.toEqual({ ok: true })
	}
})

test('writeSealKeyPair writes the private key and a sibling .pub file', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'kody-seal-keygen-'))
	const privateKeyPath = path.join(directory, 'nested', 'key')
	try {
		const pair = await writeSealKeyPair(privateKeyPath)
		expect(pair.publicKeyPath).toBe(recipientPublicKeyPath(privateKeyPath))
		const published = await readFile(pair.publicKeyPath, 'utf8')
		expect(published.trim()).toBe(pair.publicKey)
		expect((await stat(path.dirname(privateKeyPath))).mode & 0o777).toBe(0o700)
		const envelope = await sealJson(
			{ n: 1 },
			await importRecipientPublicKey(published),
		)
		await expect(
			openSealedJson(envelope, await readFile(privateKeyPath, 'utf8')),
		).resolves.toEqual({ n: 1 })
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test('writeSealKeyPair refuses to overwrite an existing private key or .pub', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'kody-seal-keep-'))
	try {
		const privateKeyPath = path.join(directory, 'key')
		await writeFile(privateKeyPath, 'old-private\n', { mode: 0o600 })
		await writeFile(recipientPublicKeyPath(privateKeyPath), 'old-pub\n', {
			mode: 0o600,
		})
		await expect(writeSealKeyPair(privateKeyPath)).rejects.toThrow(
			'Refusing to overwrite existing key',
		)
		expect(await readFile(privateKeyPath, 'utf8')).toBe('old-private\n')
		expect(await readFile(recipientPublicKeyPath(privateKeyPath), 'utf8')).toBe(
			'old-pub\n',
		)

		const blocked = path.join(directory, 'blocked', 'key')
		await mkdir(path.dirname(blocked), { recursive: true })
		await writeFile(blocked, 'keep-private\n', { mode: 0o600 })
		await mkdir(recipientPublicKeyPath(blocked))
		await expect(writeSealKeyPair(blocked)).rejects.toThrow(
			'Refusing to overwrite existing key',
		)
		expect(await readFile(blocked, 'utf8')).toBe('keep-private\n')
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})
