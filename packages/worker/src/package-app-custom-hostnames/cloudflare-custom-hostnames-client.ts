import {
	CloudflareApiError,
	CloudflareRestClient,
} from '#worker/mcp/cloudflare/cloudflare-rest-client.ts'

/**
 * Zone SSL and Certificates Edit token for Cloudflare for SaaS custom
 * hostnames (`CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN`). This is not
 * `CLOUDFLARE_API_TOKEN`. `PACKAGE_APP_ZONE_ID` is the SaaS zone id
 * (staging proof or production `kody.run` once SaaS is enabled there).
 */
export type CloudflareCustomHostnamesClientEnv = {
	CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN?: string
	PACKAGE_APP_ZONE_ID?: string
	fetcher?: Fetcher
}

export type CustomHostnameSslMethod = 'http' | 'txt'

export type CustomHostnameDnsRecord = {
	type: string
	name: string
	value: string
}

export type CloudflareCustomHostnameResult = {
	id: string
	hostname: string
	hostnameStatus: string
	sslStatus: string | null
	ownershipVerification: CustomHostnameDnsRecord | null
	sslValidationRecords: Array<CustomHostnameDnsRecord>
}

type CustomHostnameApiResult = {
	id?: unknown
	hostname?: unknown
	status?: unknown
	ownership_verification?: {
		type?: unknown
		name?: unknown
		value?: unknown
	} | null
	ssl?: {
		status?: unknown
		validation_records?: Array<{
			txt_name?: unknown
			txt_value?: unknown
			http_url?: unknown
			http_body?: unknown
		}> | null
	} | null
}

type CustomHostnameApiEnvelope = {
	success?: unknown
	errors?: Array<{ message?: unknown; code?: unknown }>
	result?: CustomHostnameApiResult | null
}

function requireToken(token: string | undefined) {
	const trimmed = token?.trim() ?? ''
	if (!trimmed) {
		throw new Error(
			'CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN is not set. Mint a zone-limited token with Zone SSL and Certificates Edit for the package-app SaaS zone (#3612). Do not reuse CLOUDFLARE_API_TOKEN.',
		)
	}
	return trimmed
}

function requireZoneId(zoneId: string | undefined) {
	const trimmed = zoneId?.trim() ?? ''
	if (!trimmed) {
		throw new Error(
			'PACKAGE_APP_ZONE_ID is not set. Point it at the package-app SaaS zone. Do not assume the production kody.run zone without enabling Cloudflare for SaaS there.',
		)
	}
	if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
		throw new Error('PACKAGE_APP_ZONE_ID must be a Cloudflare zone id.')
	}
	return trimmed
}

function assertCustomHostnameId(id: string) {
	const trimmed = id.trim()
	if (!trimmed || trimmed.includes('/') || trimmed.includes('..')) {
		throw new Error('Custom hostname id is invalid.')
	}
	return trimmed
}

function readDnsRecord(input: {
	type?: unknown
	name?: unknown
	value?: unknown
}): CustomHostnameDnsRecord | null {
	const type = typeof input.type === 'string' ? input.type.trim() : ''
	const name = typeof input.name === 'string' ? input.name.trim() : ''
	const value = typeof input.value === 'string' ? input.value.trim() : ''
	if (!type || !name || !value) return null
	return { type, name, value }
}

function readSslValidationRecords(
	ssl: CustomHostnameApiResult['ssl'],
): Array<CustomHostnameDnsRecord> {
	const records = ssl?.validation_records
	if (!Array.isArray(records)) return []
	const out: Array<CustomHostnameDnsRecord> = []
	for (const record of records) {
		const txtName =
			typeof record.txt_name === 'string' ? record.txt_name.trim() : ''
		const txtValue =
			typeof record.txt_value === 'string' ? record.txt_value.trim() : ''
		if (txtName && txtValue) {
			out.push({ type: 'txt', name: txtName, value: txtValue })
			continue
		}
		const httpUrl =
			typeof record.http_url === 'string' ? record.http_url.trim() : ''
		const httpBody =
			typeof record.http_body === 'string' ? record.http_body.trim() : ''
		if (httpUrl && httpBody) {
			out.push({ type: 'http', name: httpUrl, value: httpBody })
		}
	}
	return out
}

function readCustomHostnameResult(
	body: unknown,
	status: number,
): CloudflareCustomHostnameResult {
	const envelope = body as CustomHostnameApiEnvelope | null
	if (!envelope || envelope.success !== true || !envelope.result) {
		const message =
			typeof envelope?.errors?.[0]?.message === 'string'
				? envelope.errors[0].message
				: `Cloudflare custom hostname request failed (${status}).`
		throw new CloudflareApiError(message, { status })
	}
	const result = envelope.result
	if (typeof result.id !== 'string' || !result.id) {
		throw new CloudflareApiError(
			`Cloudflare custom hostname response did not include an id (${status}).`,
			{ status },
		)
	}
	const hostname = typeof result.hostname === 'string' ? result.hostname : ''
	const hostnameStatus = typeof result.status === 'string' ? result.status : ''
	const sslStatus =
		typeof result.ssl?.status === 'string' ? result.ssl.status : null
	const ownership = result.ownership_verification
		? readDnsRecord(result.ownership_verification)
		: null
	return {
		id: result.id,
		hostname,
		hostnameStatus,
		sslStatus,
		ownershipVerification: ownership,
		sslValidationRecords: readSslValidationRecords(result.ssl),
	}
}

export class CloudflareCustomHostnamesClient {
	private readonly client: CloudflareRestClient
	private readonly zoneId: string

	constructor(env: CloudflareCustomHostnamesClientEnv) {
		this.zoneId = requireZoneId(env.PACKAGE_APP_ZONE_ID)
		this.client = new CloudflareRestClient({
			apiToken: requireToken(env.CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN),
			fetcher: env.fetcher,
		})
	}

	private collectionPath() {
		return `/client/v4/zones/${this.zoneId}/custom_hostnames`
	}

	private hostnamePath(id: string) {
		return `${this.collectionPath()}/${assertCustomHostnameId(id)}`
	}

	async addCustomHostname(input: {
		hostname: string
		sslMethod?: CustomHostnameSslMethod
	}): Promise<CloudflareCustomHostnameResult> {
		const hostname = input.hostname.trim().toLowerCase()
		if (!hostname) {
			throw new Error('hostname is required to add a custom hostname.')
		}
		const sslMethod = input.sslMethod ?? 'http'
		switch (sslMethod) {
			case 'http':
			case 'txt':
				break
			default: {
				sslMethod satisfies never
				throw new Error('sslMethod must be http or txt.')
			}
		}
		const response = await this.client.rawRequest({
			method: 'POST',
			path: this.collectionPath(),
			body: {
				hostname,
				ssl: {
					method: sslMethod,
					type: 'dv',
				},
			},
		})
		return readCustomHostnameResult(response.body, response.status)
	}

	async getCustomHostname(input: {
		id: string
	}): Promise<CloudflareCustomHostnameResult> {
		const response = await this.client.rawRequest({
			method: 'GET',
			path: this.hostnamePath(input.id),
		})
		return readCustomHostnameResult(response.body, response.status)
	}

	/**
	 * Delete a custom hostname. A 404 means Cloudflare already dropped it —
	 * treat that as success so local cleanup can proceed.
	 */
	async deleteCustomHostname(input: {
		id: string
	}): Promise<CloudflareCustomHostnameResult | { alreadyGone: true }> {
		const response = await this.client.rawRequest({
			method: 'DELETE',
			path: this.hostnamePath(input.id),
		})
		if (response.status === 404) {
			return { alreadyGone: true }
		}
		return readCustomHostnameResult(response.body, response.status)
	}
}
