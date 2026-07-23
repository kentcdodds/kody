/**
 * Seal SECRET_STORE_KEY (or any escrow secret) into the DR backup bucket.
 *
 * Env:
 * - ESCROW_SECRET_VALUE — plaintext secret to seal (never logged)
 * - ESCROW_PASSPHRASE — operator passphrase for PBKDF2 (never logged)
 * - ESCROW_LABEL — label recorded on the sealed blob
 * - ESCROW_KEY_VERSION — optional key version segment (default `v1`)
 * - DR_BACKUP_ACCOUNT_ID / DR_BACKUP_BUCKET_NAME
 * - DR_BACKUP_ACCESS_KEY_ID / DR_BACKUP_SECRET_ACCESS_KEY
 *
 * Dependency-free: node:crypto + hand-rolled SigV4 for the PUT.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	pbkdf2Sync,
	randomBytes,
} from 'node:crypto'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	backupEscrowSecretStoreKeyKey,
	parseSealedEscrowBlob,
	type SealedEscrowBlob,
} from '@kody-internal/shared/backup-staging.ts'

const pbkdf2Iterations = 600_000
const saltBytes = 16
const ivBytes = 12
const keyBytes = 32
const escrowKeyVersionPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function sha256(data: string | Buffer) {
	return createHash('sha256').update(data).digest()
}

function hmacSha256(key: Buffer | string, data: string | Buffer) {
	return createHmac('sha256', key).update(data).digest()
}

function encodeRfc3986(value: string) {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	)
}

/**
 * Build the escrow object key. Default `v1` matches
 * {@link backupEscrowSecretStoreKeyKey} from the shared staging contract.
 */
export function buildEscrowSecretStoreKey(version = 'v1'): string {
	const normalized = version.trim() || 'v1'
	if (!escrowKeyVersionPattern.test(normalized)) {
		throw new Error(
			`Invalid ESCROW_KEY_VERSION "${version}": use a short alphanumeric token (e.g. v1, v2)`,
		)
	}
	return `escrow/secret-store-key.${normalized}.json`
}

export function sealEscrowSecret(input: {
	secretValue: string
	passphrase: string
	label: string
	sealedAt?: string
	salt?: Buffer
	iv?: Buffer
}): SealedEscrowBlob {
	const salt = input.salt ?? randomBytes(saltBytes)
	const iv = input.iv ?? randomBytes(ivBytes)
	const key = pbkdf2Sync(
		input.passphrase,
		salt,
		pbkdf2Iterations,
		keyBytes,
		'sha256',
	)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const ciphertext = Buffer.concat([
		cipher.update(input.secretValue, 'utf8'),
		cipher.final(),
	])
	const authTag = cipher.getAuthTag()
	const sealed: SealedEscrowBlob = {
		schemaVersion: 1,
		kdf: 'pbkdf2-sha256',
		iterations: pbkdf2Iterations,
		saltBase64: salt.toString('base64'),
		ivBase64: iv.toString('base64'),
		ciphertextBase64: Buffer.concat([ciphertext, authTag]).toString('base64'),
		sealedAt: input.sealedAt ?? new Date().toISOString(),
		label: input.label,
	}
	return parseSealedEscrowBlob(sealed)
}

/** Test-only helper: reverse {@link sealEscrowSecret}. */
export function unsealEscrowSecretForTests(
	blob: SealedEscrowBlob,
	passphrase: string,
): string {
	const parsed = parseSealedEscrowBlob(blob)
	const salt = Buffer.from(parsed.saltBase64, 'base64')
	const iv = Buffer.from(parsed.ivBase64, 'base64')
	const packed = Buffer.from(parsed.ciphertextBase64, 'base64')
	const authTag = packed.subarray(packed.length - 16)
	const ciphertext = packed.subarray(0, packed.length - 16)
	const key = pbkdf2Sync(
		passphrase,
		salt,
		parsed.iterations,
		keyBytes,
		'sha256',
	)
	const decipher = createDecipheriv('aes-256-gcm', key, iv)
	decipher.setAuthTag(authTag)
	return Buffer.concat([
		decipher.update(ciphertext),
		decipher.final(),
	]).toString('utf8')
}

function isWriteOnceRejection(status: number, bodyText: string) {
	if (status === 409 || status === 412) return true
	if (status === 403 || status === 400) {
		const lower = bodyText.toLowerCase()
		return (
			lower.includes('lock') ||
			lower.includes('retention') ||
			lower.includes('precondition') ||
			lower.includes('accessdenied')
		)
	}
	return false
}

export async function putSealedEscrowBlob(input: {
	accountId: string
	bucketName: string
	accessKeyId: string
	secretAccessKey: string
	body: string
	objectKey?: string
	fetchImpl?: typeof fetch
}): Promise<void> {
	const objectKey = input.objectKey ?? backupEscrowSecretStoreKeyKey
	const encodedKey = objectKey
		.split('/')
		.map((part) => encodeRfc3986(part))
		.join('/')
	const url = new URL(
		`https://${input.accountId}.r2.cloudflarestorage.com/${encodeRfc3986(input.bucketName)}/${encodedKey}`,
	)
	const now = new Date()
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
	const dateStamp = amzDate.slice(0, 8)
	const region = 'auto'
	const service = 's3'
	const payloadHash = sha256(input.body).toString('hex')
	const canonicalHeaders = [
		`host:${url.host}`,
		`x-amz-content-sha256:${payloadHash}`,
		`x-amz-date:${amzDate}`,
	].join('\n')
	const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
	const canonicalRequest = [
		'PUT',
		url.pathname,
		'',
		`${canonicalHeaders}\n`,
		signedHeaders,
		payloadHash,
	].join('\n')
	const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		credentialScope,
		sha256(canonicalRequest).toString('hex'),
	].join('\n')
	const kDate = hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp)
	const kRegion = hmacSha256(kDate, region)
	const kService = hmacSha256(kRegion, service)
	const kSigning = hmacSha256(kService, 'aws4_request')
	const signature = hmacSha256(kSigning, stringToSign).toString('hex')
	const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
	const fetchImpl = input.fetchImpl ?? fetch
	const response = await fetchImpl(url, {
		method: 'PUT',
		headers: {
			Authorization: authorization,
			'Content-Type': 'application/json',
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
		},
		body: input.body,
	})
	if (!response.ok) {
		const bodyText = await response.text().catch(() => '')
		if (isWriteOnceRejection(response.status, bodyText)) {
			throw new Error(
				`Escrow object ${objectKey} is write-once under the DR bucket escrow/ lock rule; a second PUT to this key is rejected (HTTP ${response.status}). Rotate by setting ESCROW_KEY_VERSION to a new version (for example v2) so the object key becomes escrow/secret-store-key.v2.json.`,
			)
		}
		throw new Error(
			`Escrow PUT failed for ${objectKey}: HTTP ${response.status}`,
		)
	}
}

export async function main(env: NodeJS.ProcessEnv = process.env) {
	const secretValue = env.ESCROW_SECRET_VALUE
	const passphrase = env.ESCROW_PASSPHRASE
	const label = env.ESCROW_LABEL
	const accountId = env.DR_BACKUP_ACCOUNT_ID
	const bucketName = env.DR_BACKUP_BUCKET_NAME
	const accessKeyId = env.DR_BACKUP_ACCESS_KEY_ID
	const secretAccessKey = env.DR_BACKUP_SECRET_ACCESS_KEY
	for (const [name, value] of [
		['ESCROW_SECRET_VALUE', secretValue],
		['ESCROW_PASSPHRASE', passphrase],
		['ESCROW_LABEL', label],
		['DR_BACKUP_ACCOUNT_ID', accountId],
		['DR_BACKUP_BUCKET_NAME', bucketName],
		['DR_BACKUP_ACCESS_KEY_ID', accessKeyId],
		['DR_BACKUP_SECRET_ACCESS_KEY', secretAccessKey],
	] as const) {
		if (typeof value !== 'string' || value.length === 0) {
			throw new Error(`Missing required environment variable: ${name}`)
		}
	}
	const version = env.ESCROW_KEY_VERSION?.trim() || 'v1'
	const objectKey = buildEscrowSecretStoreKey(version)
	if (version === 'v1' && objectKey !== backupEscrowSecretStoreKeyKey) {
		throw new Error(
			`Escrow v1 key drift: built ${objectKey}, contract expects ${backupEscrowSecretStoreKeyKey}`,
		)
	}
	const sealed = sealEscrowSecret({
		secretValue: secretValue!,
		passphrase: passphrase!,
		label: label!,
	})
	const body = JSON.stringify(sealed)
	await putSealedEscrowBlob({
		accountId: accountId!,
		bucketName: bucketName!,
		accessKeyId: accessKeyId!,
		secretAccessKey: secretAccessKey!,
		body,
		objectKey,
	})
	console.log(
		JSON.stringify({
			ok: true,
			objectKey,
			label: sealed.label,
			sealedAt: sealed.sealedAt,
			iterations: sealed.iterations,
		}),
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error)
		console.error(message)
		process.exitCode = 1
	})
}
