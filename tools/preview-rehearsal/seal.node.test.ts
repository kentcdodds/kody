import { expect, test } from 'vitest'
import {
	generateSealKeyPair,
	importRecipientPublicKey,
	openSealedJson,
	sealJson,
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
