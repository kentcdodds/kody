/**
 * Recover SECRET_STORE_KEY from its sealed DR escrow blob.
 *
 * Usage:
 *   node tools/disaster-recovery/unseal-escrow.ts [--input <file>] [--output <file>]
 *
 * Env:
 * - SECRET_ESCROW_PASSPHRASE — operator passphrase (prompted when omitted)
 * - ESCROW_INPUT_PATH — optional local sealed blob (equivalent to `--input`)
 * - ESCROW_OUTPUT_PATH — optional destination outside the repository
 * - ESCROW_KEY_VERSION — optional DR object version (default `v1`)
 * - DR_BACKUP_ACCOUNT_ID / DR_BACKUP_BUCKET_NAME
 * - DR_BACKUP_ACCESS_KEY_ID / DR_BACKUP_SECRET_ACCESS_KEY
 *
 * Without an input path, the sealed blob is read from the DR bucket. Without an
 * output path, the recovered value is written directly to stdout. Secret
 * material is never logged.
 */
import {
	createDecipheriv,
	createHash,
	createHmac,
	pbkdf2Sync,
} from 'node:crypto'
import { open, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isExecutedDirectly } from '../node-runtime.ts'
import { buildEscrowSecretStoreKey } from './seal-escrow.ts'
import {
	parseSealedEscrowBlob,
	type SealedEscrowBlob,
} from '@kody-internal/shared/backup-staging.ts'

const pbkdf2Iterations = 600_000
const saltBytes = 16
const ivBytes = 12
const authTagBytes = 16
const keyBytes = 32
const repositoryRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../..',
)

type CliOptions = {
	inputPath?: string
	outputPath?: string
}

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

function decodeCanonicalBase64(value: string, fieldName: string): Buffer {
	const decoded = Buffer.from(value, 'base64')
	if (decoded.toString('base64') !== value) {
		throw new Error(`Sealed escrow blob has invalid ${fieldName}`)
	}
	return decoded
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name]
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`Missing required environment variable: ${name}`)
	}
	return value
}

export function parseArgs(argv: Array<string>): CliOptions {
	const options: CliOptions = {}
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		switch (argument) {
			case '--input':
			case '--output': {
				const value = argv[index + 1]
				if (!value || value.startsWith('--')) {
					throw new Error(`${argument} requires a file path`)
				}
				if (argument === '--input') options.inputPath = value
				else options.outputPath = value
				index += 1
				break
			}
			default: {
				throw new Error(`Unknown argument: ${argument}`)
			}
		}
	}
	return options
}

export function unsealEscrowSecret(blob: unknown, passphrase: string): string {
	const parsed = parseSealedEscrowBlob(blob)
	if (parsed.iterations !== pbkdf2Iterations) {
		throw new Error(
			`Unsupported sealed escrow PBKDF2 iteration count: ${parsed.iterations}`,
		)
	}

	const salt = decodeCanonicalBase64(parsed.saltBase64, 'saltBase64')
	const iv = decodeCanonicalBase64(parsed.ivBase64, 'ivBase64')
	const packed = decodeCanonicalBase64(
		parsed.ciphertextBase64,
		'ciphertextBase64',
	)
	if (salt.length !== saltBytes || iv.length !== ivBytes) {
		throw new Error('Sealed escrow blob has invalid salt or IV length')
	}
	if (packed.length <= authTagBytes) {
		throw new Error('Sealed escrow blob has invalid ciphertext length')
	}

	const authTag = packed.subarray(packed.length - authTagBytes)
	const ciphertext = packed.subarray(0, packed.length - authTagBytes)
	const key = pbkdf2Sync(
		passphrase,
		salt,
		parsed.iterations,
		keyBytes,
		'sha256',
	)
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		decipher.setAuthTag(authTag)
		const plaintext = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		])
		try {
			return plaintext.toString('utf8')
		} finally {
			plaintext.fill(0)
		}
	} catch {
		throw new Error(
			'Escrow unseal failed: passphrase is incorrect or sealed blob authentication failed',
		)
	} finally {
		key.fill(0)
	}
}

export async function getSealedEscrowBlob(input: {
	accountId: string
	bucketName: string
	accessKeyId: string
	secretAccessKey: string
	objectKey: string
	fetchImpl?: typeof fetch
}): Promise<string> {
	const encodedKey = input.objectKey
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
	const payloadHash = sha256('').toString('hex')
	const canonicalHeaders = [
		`host:${url.host}`,
		`x-amz-content-sha256:${payloadHash}`,
		`x-amz-date:${amzDate}`,
	].join('\n')
	const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
	const canonicalRequest = [
		'GET',
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
		method: 'GET',
		signal: AbortSignal.timeout(30_000),
		headers: {
			Authorization: authorization,
			'x-amz-content-sha256': payloadHash,
			'x-amz-date': amzDate,
		},
	})
	if (!response.ok) {
		throw new Error(
			`Escrow GET failed for ${input.objectKey}: HTTP ${response.status}`,
		)
	}
	return response.text()
}

async function promptForPassphrase(): Promise<string> {
	const input = process.stdin
	if (!input.isTTY || typeof input.setRawMode !== 'function') {
		throw new Error(
			'SECRET_ESCROW_PASSPHRASE is required when stdin is not an interactive terminal',
		)
	}

	process.stderr.write('Escrow passphrase: ')
	input.setRawMode(true)
	input.setEncoding('utf8')
	input.resume()
	return new Promise((resolve, reject) => {
		let passphrase = ''
		const cleanup = () => {
			input.off('data', onData)
			input.setRawMode(false)
			input.pause()
			process.stderr.write('\n')
		}
		const onData = (chunk: string) => {
			for (const character of chunk) {
				if (character === '\r' || character === '\n') {
					cleanup()
					if (passphrase.length === 0) {
						reject(new Error('Escrow passphrase must not be empty'))
					} else {
						resolve(passphrase)
					}
					return
				}
				if (character === '\u0003') {
					cleanup()
					reject(new Error('Escrow unseal cancelled'))
					return
				}
				if (character === '\u007f' || character === '\b') {
					passphrase = Array.from(passphrase).slice(0, -1).join('')
				} else {
					passphrase += character
				}
			}
		}
		input.on('data', onData)
	})
}

async function writeRecoveredSecret(
	secretValue: string,
	outputPath: string | undefined,
): Promise<void> {
	if (!outputPath) {
		process.stdout.write(secretValue)
		return
	}

	const resolvedOutputPath = path.resolve(outputPath)
	const resolvedParent = await realpath(path.dirname(resolvedOutputPath))
	const checkedOutputPath = path.join(
		resolvedParent,
		path.basename(resolvedOutputPath),
	)
	const resolvedRepositoryRoot = await realpath(repositoryRoot)
	const relativeToRepository = path.relative(
		resolvedRepositoryRoot,
		checkedOutputPath,
	)
	if (
		relativeToRepository === '' ||
		(!relativeToRepository.startsWith(`..${path.sep}`) &&
			relativeToRepository !== '..' &&
			!path.isAbsolute(relativeToRepository))
	) {
		throw new Error('Refusing to write recovered secret inside the repository')
	}

	const output = await open(checkedOutputPath, 'wx', 0o600)
	try {
		await output.writeFile(secretValue, 'utf8')
	} finally {
		await output.close()
	}
}

export async function main(
	env: NodeJS.ProcessEnv = process.env,
	argv: Array<string> = process.argv.slice(2),
) {
	const options = parseArgs(argv)
	const inputPath = options.inputPath ?? env.ESCROW_INPUT_PATH
	const outputPath = options.outputPath ?? env.ESCROW_OUTPUT_PATH

	const body = inputPath
		? await readFile(path.resolve(inputPath), 'utf8')
		: await getSealedEscrowBlob({
				accountId: requiredEnv(env, 'DR_BACKUP_ACCOUNT_ID'),
				bucketName: requiredEnv(env, 'DR_BACKUP_BUCKET_NAME'),
				accessKeyId: requiredEnv(env, 'DR_BACKUP_ACCESS_KEY_ID'),
				secretAccessKey: requiredEnv(env, 'DR_BACKUP_SECRET_ACCESS_KEY'),
				objectKey: buildEscrowSecretStoreKey(
					env.ESCROW_KEY_VERSION?.trim() || 'v1',
				),
			})
	let inputValue: unknown
	try {
		inputValue = JSON.parse(body)
	} catch {
		throw new Error('Sealed escrow input is not valid JSON')
	}
	const blob: SealedEscrowBlob = parseSealedEscrowBlob(inputValue)
	const passphrase = env.SECRET_ESCROW_PASSPHRASE?.length
		? env.SECRET_ESCROW_PASSPHRASE
		: await promptForPassphrase()
	const secretValue = unsealEscrowSecret(blob, passphrase)
	await writeRecoveredSecret(secretValue, outputPath)
	return secretValue
}

if (isExecutedDirectly(import.meta.url)) {
	await main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error)
		console.error(message)
		process.exitCode = 1
	})
}
