import {
	CloudflareApiError,
	CloudflareRestClient,
} from '#worker/mcp/cloudflare/cloudflare-rest-client.ts'

/**
 * Zone SSL and Certificates Edit token for Cloudflare for SaaS custom
 * hostnames. This is not `CLOUDFLARE_API_TOKEN` and does not exist yet
 * (#3612). `PACKAGE_APP_ZONE_ID` is the SaaS zone used for proof (a staging
 * copy). Do not point it at the production kody.run zone from this client.
 *
 * Request handling does not call Cloudflare. These methods are the write
 * path a later change will use.
 */
export type CloudflareCustomHostnamesClientEnv = {
	CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN?: string
	PACKAGE_APP_ZONE_ID?: string
	fetcher?: Fetcher
}

export type CloudflareCustomHostnameResult = {
	id: string
	hostname: string
	hostnameStatus: string
	sslStatus: string | null
}

type CustomHostnameApiResult = {
	id?: unknown
	hostname?: unknown
	status?: unknown
	ssl?: { status?: unknown } | null
}

type CustomHostnameApiEnvelope = {
	success?: unknown
	errors?: Array<{ message?: unknown }>
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
			'PACKAGE_APP_ZONE_ID is not set. Point it at the package-app SaaS zone used for staging proof. Do not assume the production kody.run zone.',
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
	return {
		id: result.id,
		hostname,
		hostnameStatus,
		sslStatus,
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
	}): Promise<CloudflareCustomHostnameResult> {
		const hostname = input.hostname.trim().toLowerCase()
		if (!hostname) {
			throw new Error('hostname is required to add a custom hostname.')
		}
		const response = await this.client.rawRequest({
			method: 'POST',
			path: this.collectionPath(),
			body: {
				hostname,
				ssl: {
					method: 'http',
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

	async deleteCustomHostname(input: {
		id: string
	}): Promise<CloudflareCustomHostnameResult> {
		const response = await this.client.rawRequest({
			method: 'DELETE',
			path: this.hostnamePath(input.id),
		})
		return readCustomHostnameResult(response.body, response.status)
	}
}
