import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from 'node:crypto'

const ENCRYPTED_SECRET_PREFIX = 'enc:v1:'
const AUTH_TAG_BYTES = 16

function getEncryptionKey(sharedSecret: string) {
	return createHash('sha256').update(sharedSecret).digest()
}

export function encryptSecret(input: {
	value: string
	sharedSecret: string | null
	missingSecretMessage: string
}) {
	if (!input.sharedSecret) {
		throw new Error(input.missingSecretMessage)
	}
	const iv = randomBytes(12)
	const key = getEncryptionKey(input.sharedSecret)
	const cipher = createCipheriv('aes-256-gcm', key, iv)
	const encrypted = Buffer.concat([
		cipher.update(input.value, 'utf8'),
		cipher.final(),
	])
	const tag = cipher.getAuthTag()
	return `${ENCRYPTED_SECRET_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`
}

export function decryptSecret(
	value: string | null,
	sharedSecret: string | null,
) {
	if (!value || !value.startsWith(ENCRYPTED_SECRET_PREFIX)) {
		return value
	}
	if (!sharedSecret) {
		return null
	}
	const payload = value.slice(ENCRYPTED_SECRET_PREFIX.length)
	const [ivBase64, tagBase64, encryptedBase64] = payload.split(':')
	if (!ivBase64 || !tagBase64 || !encryptedBase64) {
		return null
	}
	try {
		const key = getEncryptionKey(sharedSecret)
		const iv = Buffer.from(ivBase64, 'base64')
		const tag = Buffer.from(tagBase64, 'base64')
		const encrypted = Buffer.from(encryptedBase64, 'base64')
		if (iv.length !== 12 || tag.length !== AUTH_TAG_BYTES) {
			return null
		}
		const decipher = createDecipheriv('aes-256-gcm', key, iv)
		decipher.setAuthTag(tag)
		const decrypted = Buffer.concat([
			decipher.update(encrypted),
			decipher.final(),
		])
		return decrypted.toString('utf8')
	} catch {
		return null
	}
}
