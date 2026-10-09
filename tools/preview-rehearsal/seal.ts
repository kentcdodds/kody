import { readFile, writeFile } from 'node:fs/promises'
import { isExecutedDirectly } from '../node-runtime.ts'
import { fail } from '../ci/resource-utils.ts'

/**
 * Rehearsal credentials (site admin password, per-user API tokens) leave CI
 * only as a sealed envelope: AES-256-GCM content key wrapped with the
 * operator's RSA-OAEP (SHA-256) public key. Actions artifacts and logs on this
 * public repo are readable by anyone, so plaintext never goes there.
 */
export type SealedEnvelope = {
	version: 1
	algorithm: 'RSA-OAEP-256+A256GCM'
	wrappedKey: string
	iv: string
	ciphertext: string
}

const rsaParams = { name: 'RSA-OAEP', hash: 'SHA-256' } as const

function toBase64(bytes: ArrayBuffer | Uint8Array) {
	return Buffer.from(
		bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
	).toString('base64')
}

function fromBase64(value: string) {
	return new Uint8Array(Buffer.from(value.replace(/\s+/g, ''), 'base64'))
}

export async function generateSealKeyPair() {
	const pair = await crypto.subtle.generateKey(
		{
			...rsaParams,
			modulusLength: 4096,
			publicExponent: new Uint8Array([1, 0, 1]),
		},
		true,
		['encrypt', 'decrypt'],
	)
	return {
		publicKey: toBase64(await crypto.subtle.exportKey('spki', pair.publicKey)),
		privateKey: toBase64(
			await crypto.subtle.exportKey('pkcs8', pair.privateKey),
		),
	}
}

export async function sealJson(
	value: unknown,
	publicKeyBase64: string,
): Promise<SealedEnvelope> {
	let publicKey: CryptoKey
	try {
		publicKey = await crypto.subtle.importKey(
			'spki',
			fromBase64(publicKeyBase64),
			rsaParams,
			false,
			['encrypt'],
		)
	} catch (error) {
		throw new Error(
			`recipient public key is not a base64 SPKI RSA key: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const contentKey = crypto.getRandomValues(new Uint8Array(32))
	const iv = crypto.getRandomValues(new Uint8Array(12))
	const aesKey = await crypto.subtle.importKey(
		'raw',
		contentKey,
		'AES-GCM',
		false,
		['encrypt'],
	)
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		aesKey,
		new TextEncoder().encode(JSON.stringify(value)),
	)
	const wrappedKey = await crypto.subtle.encrypt(
		rsaParams,
		publicKey,
		contentKey,
	)
	return {
		version: 1,
		algorithm: 'RSA-OAEP-256+A256GCM',
		wrappedKey: toBase64(wrappedKey),
		iv: toBase64(iv),
		ciphertext: toBase64(ciphertext),
	}
}

export async function openSealedJson(
	envelope: SealedEnvelope,
	privateKeyBase64: string,
): Promise<unknown> {
	if (envelope.version !== 1 || envelope.algorithm !== 'RSA-OAEP-256+A256GCM') {
		throw new Error('Unsupported sealed envelope.')
	}
	const privateKey = await crypto.subtle.importKey(
		'pkcs8',
		fromBase64(privateKeyBase64),
		rsaParams,
		false,
		['decrypt'],
	)
	let plaintext: ArrayBuffer
	try {
		const contentKey = await crypto.subtle.decrypt(
			rsaParams,
			privateKey,
			fromBase64(envelope.wrappedKey),
		)
		const aesKey = await crypto.subtle.importKey(
			'raw',
			contentKey,
			'AES-GCM',
			false,
			['decrypt'],
		)
		plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64(envelope.iv) },
			aesKey,
			fromBase64(envelope.ciphertext),
		)
	} catch {
		throw new Error(
			'Could not open the sealed envelope: wrong private key, or the envelope was modified.',
		)
	}
	return JSON.parse(new TextDecoder().decode(plaintext))
}

const usage = [
	'Usage:',
	'  node tools/preview-rehearsal/seal.ts keygen --private-key <path>   (prints the public key)',
	'  node tools/preview-rehearsal/seal.ts open --private-key <path> --in <sealed.json> --out <plain.json>',
].join('\n')

function readFlag(argv: Array<string>, flag: string) {
	const index = argv.indexOf(flag)
	const value = index === -1 ? undefined : argv[index + 1]
	if (!value) fail(`Missing ${flag} <value>.\n${usage}`)
	return value
}

if (isExecutedDirectly(import.meta.url)) {
	const argv = process.argv.slice(2)
	const command = argv[0]
	switch (command) {
		case 'keygen': {
			const privateKeyPath = readFlag(argv, '--private-key')
			const pair = await generateSealKeyPair()
			await writeFile(privateKeyPath, `${pair.privateKey}\n`, { mode: 0o600 })
			console.error(`Wrote the private key to ${privateKeyPath} (mode 600).`)
			console.log(pair.publicKey)
			break
		}
		case 'open': {
			const privateKey = await readFile(readFlag(argv, '--private-key'), 'utf8')
			const envelope = JSON.parse(
				await readFile(readFlag(argv, '--in'), 'utf8'),
			) as SealedEnvelope
			const outPath = readFlag(argv, '--out')
			const value = await openSealedJson(envelope, privateKey)
			await writeFile(outPath, `${JSON.stringify(value, null, 2)}\n`, {
				mode: 0o600,
			})
			console.error(`Wrote the opened credentials to ${outPath} (mode 600).`)
			break
		}
		default:
			fail(usage)
	}
}
