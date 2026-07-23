import { AwsClient } from 'aws4fetch'

export type DrBackupS3Config = {
	accountId: string
	bucketName: string
	accessKeyId: string
	secretAccessKey: string
}

export type DrBackupS3Client = {
	head: (key: string) => Promise<{ exists: boolean; status: number }>
	getText: (key: string) => Promise<string | null>
	getBytes: (key: string) => Promise<Uint8Array | null>
	put: (
		key: string,
		body: string | Uint8Array,
		contentType?: string,
	) => Promise<void>
}

function objectUrl(config: DrBackupS3Config, key: string) {
	const encodedKey = key
		.split('/')
		.map((part) => encodeURIComponent(part))
		.join('/')
	return `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucketName)}/${encodedKey}`
}

export function createDrBackupS3Client(
	config: DrBackupS3Config,
	fetchImpl: typeof fetch = fetch,
): DrBackupS3Client {
	const aws = new AwsClient({
		accessKeyId: config.accessKeyId,
		secretAccessKey: config.secretAccessKey,
		service: 's3',
		region: 'auto',
	})

	async function signedFetch(key: string, init?: RequestInit) {
		const request = await aws.sign(objectUrl(config, key), init)
		return fetchImpl(request)
	}

	return {
		async head(key) {
			const response = await signedFetch(key, { method: 'HEAD' })
			if (response.status === 404) {
				return { exists: false, status: response.status }
			}
			if (!response.ok && response.status !== 404) {
				throw new Error(
					`DR backup HEAD failed for ${key}: HTTP ${response.status}`,
				)
			}
			return { exists: response.ok, status: response.status }
		},
		async getText(key) {
			const response = await signedFetch(key, { method: 'GET' })
			if (response.status === 404) return null
			if (!response.ok) {
				throw new Error(
					`DR backup GET failed for ${key}: HTTP ${response.status}`,
				)
			}
			return await response.text()
		},
		async getBytes(key) {
			const response = await signedFetch(key, { method: 'GET' })
			if (response.status === 404) return null
			if (!response.ok) {
				throw new Error(
					`DR backup GET failed for ${key}: HTTP ${response.status}`,
				)
			}
			return new Uint8Array(await response.arrayBuffer())
		},
		async put(key, body, contentType = 'application/octet-stream') {
			const response = await signedFetch(key, {
				method: 'PUT',
				headers: {
					'Content-Type': contentType,
				},
				body: body as BodyInit,
			})
			if (!response.ok) {
				throw new Error(
					`DR backup PUT failed for ${key}: HTTP ${response.status}`,
				)
			}
		},
	}
}

export function readDrBackupS3Config(
	env: Pick<
		Env,
		| 'DR_BACKUP_ACCOUNT_ID'
		| 'DR_BACKUP_BUCKET_NAME'
		| 'DR_BACKUP_ACCESS_KEY_ID'
		| 'DR_BACKUP_SECRET_ACCESS_KEY'
	>,
): DrBackupS3Config | null {
	const accountId = env.DR_BACKUP_ACCOUNT_ID?.trim()
	const bucketName = env.DR_BACKUP_BUCKET_NAME?.trim()
	const accessKeyId = env.DR_BACKUP_ACCESS_KEY_ID?.trim()
	const secretAccessKey = env.DR_BACKUP_SECRET_ACCESS_KEY?.trim()
	if (!accountId || !bucketName || !accessKeyId || !secretAccessKey) {
		return null
	}
	return { accountId, bucketName, accessKeyId, secretAccessKey }
}
