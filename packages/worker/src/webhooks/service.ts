import { getAppBaseUrl } from '#app/app-base-url.ts'
import { resolvePublicUsername } from '#app/user-lookup.ts'
import { normalizeExportName } from '#worker/package-invocations/common.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { generateWebhookUrlSecret, hashWebhookUrlSecret } from './crypto.ts'
import { buildWebhookEndpointUrl } from './public-url.ts'
import {
	deleteWebhookEndpoint,
	getWebhookEndpointByIdForUser,
	insertWebhookEndpoint,
	listWebhookDeliveriesForEndpoint,
	listWebhookEndpointsForUser,
	updateWebhookEndpoint,
} from './repo.ts'
import {
	encryptWebhookVerificationConfig,
	parseWebhookVerificationInput,
	toPublicWebhookVerificationConfig,
} from './verification.ts'
import {
	type PublicWebhookVerificationConfig,
	type WebhookDeliveryRecord,
	type WebhookEndpointRecord,
	type WebhookResponseMode,
	type WebhookVerificationInput,
} from './types.ts'

export type PublicWebhookEndpoint = {
	id: string
	name: string
	packageId: string
	exportName: string
	responseMode: WebhookResponseMode
	enabled: boolean
	verification: PublicWebhookVerificationConfig | null
	createdAt: string
	updatedAt: string
}

export type CreatedWebhookEndpoint = PublicWebhookEndpoint & {
	url: string
	urlSecret: string
}

function toPublicEndpoint(
	record: WebhookEndpointRecord,
): PublicWebhookEndpoint {
	return {
		id: record.id,
		name: record.name,
		packageId: record.packageId,
		exportName: record.exportName,
		responseMode: record.responseMode,
		enabled: record.enabled,
		verification: toPublicWebhookVerificationConfig(record.verificationConfig),
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	}
}

async function resolveOwnerUsername(input: {
	db: D1Database
	userId: string
	email?: string | null
	username?: string | null
}) {
	if (input.username?.trim()) return input.username.trim()
	const resolved = await resolvePublicUsername({
		db: input.db,
		email: input.email,
	})
	if (!resolved) {
		throw new Error(
			'A public username is required to create webhook endpoint URLs.',
		)
	}
	return resolved
}

async function resolveBoundPackage(input: {
	db: D1Database
	userId: string
	packageId?: string
	kodyId?: string
}) {
	const packageIdOrKodyId = (input.packageId ?? input.kodyId ?? '').trim()
	if (!packageIdOrKodyId) {
		throw new Error('packageId or kodyId is required.')
	}
	const savedPackage = await resolveSavedPackage({
		db: input.db,
		userId: input.userId,
		packageIdOrKodyId,
	})
	if (!savedPackage) {
		throw new Error(
			`Saved package "${packageIdOrKodyId}" was not found for this user.`,
		)
	}
	return savedPackage
}

function normalizeResponseMode(value: string | undefined): WebhookResponseMode {
	if (value === undefined || value === 'ack') return 'ack'
	if (value === 'sync') return 'sync'
	throw new Error('responseMode must be ack or sync.')
}

export async function createWebhookEndpointForUser(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	name: string
	packageId?: string
	kodyId?: string
	exportName: string
	responseMode?: string
	verification?: unknown
	requestUrl?: string | null
}): Promise<CreatedWebhookEndpoint> {
	const name = input.name.trim()
	if (!name) throw new Error('name is required.')
	const exportName = normalizeExportName(input.exportName)
	if (!exportName) throw new Error('exportName is required.')
	const responseMode = normalizeResponseMode(input.responseMode)
	const savedPackage = await resolveBoundPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})

	let verificationInput: WebhookVerificationInput | null = null
	if (input.verification !== undefined && input.verification !== null) {
		verificationInput = parseWebhookVerificationInput(input.verification)
	}
	const verificationConfig = verificationInput
		? await encryptWebhookVerificationConfig(input.env, verificationInput)
		: null

	const urlSecret = await generateWebhookUrlSecret()
	const urlSecretHash = await hashWebhookUrlSecret(urlSecret)
	const endpointId = crypto.randomUUID()
	const record = await insertWebhookEndpoint({
		db: input.env.APP_DB,
		id: endpointId,
		userId: input.userId,
		name,
		packageId: savedPackage.id,
		exportName,
		urlSecretHash,
		verificationConfig,
		responseMode,
	})

	const username = await resolveOwnerUsername({
		db: input.env.APP_DB,
		userId: input.userId,
		email: input.email,
		username: input.username,
	})
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	return {
		...toPublicEndpoint(record),
		urlSecret,
		url: buildWebhookEndpointUrl({
			origin,
			username,
			endpointId: record.id,
			urlSecret,
		}),
	}
}

export async function listWebhookEndpointsForUserService(input: {
	db: D1Database
	userId: string
}): Promise<Array<PublicWebhookEndpoint>> {
	const records = await listWebhookEndpointsForUser({
		db: input.db,
		userId: input.userId,
	})
	return records.map(toPublicEndpoint)
}

export async function getWebhookEndpointForUser(input: {
	db: D1Database
	userId: string
	endpointId: string
}): Promise<PublicWebhookEndpoint | null> {
	const record = await getWebhookEndpointByIdForUser(input)
	return record ? toPublicEndpoint(record) : null
}

export async function updateWebhookEndpointForUser(input: {
	env: Env
	userId: string
	endpointId: string
	name?: string
	packageId?: string
	kodyId?: string
	exportName?: string
	responseMode?: string
	enabled?: boolean
	verification?: unknown
	clearVerification?: boolean
}): Promise<PublicWebhookEndpoint | null> {
	let packageId: string | undefined
	if (input.packageId !== undefined || input.kodyId !== undefined) {
		const savedPackage = await resolveBoundPackage({
			db: input.env.APP_DB,
			userId: input.userId,
			packageId: input.packageId,
			kodyId: input.kodyId,
		})
		packageId = savedPackage.id
	}

	const exportName =
		input.exportName === undefined
			? undefined
			: normalizeExportName(input.exportName)
	const responseMode =
		input.responseMode === undefined
			? undefined
			: normalizeResponseMode(input.responseMode)

	let verificationConfig = undefined as
		| Awaited<ReturnType<typeof encryptWebhookVerificationConfig>>
		| undefined
	if (input.clearVerification) {
		verificationConfig = undefined
	} else if (input.verification !== undefined && input.verification !== null) {
		const parsed = parseWebhookVerificationInput(input.verification)
		verificationConfig = await encryptWebhookVerificationConfig(
			input.env,
			parsed,
		)
	}

	const record = await updateWebhookEndpoint({
		db: input.env.APP_DB,
		userId: input.userId,
		endpointId: input.endpointId,
		name: input.name?.trim(),
		packageId,
		exportName,
		responseMode,
		enabled: input.enabled,
		verificationConfig,
		clearVerificationConfig: input.clearVerification === true,
	})
	return record ? toPublicEndpoint(record) : null
}

export async function rotateWebhookEndpointSecretForUser(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	endpointId: string
	requestUrl?: string | null
}): Promise<CreatedWebhookEndpoint | null> {
	const existing = await getWebhookEndpointByIdForUser({
		db: input.env.APP_DB,
		userId: input.userId,
		endpointId: input.endpointId,
	})
	if (!existing) return null

	const urlSecret = await generateWebhookUrlSecret()
	const urlSecretHash = await hashWebhookUrlSecret(urlSecret)
	const record = await updateWebhookEndpoint({
		db: input.env.APP_DB,
		userId: input.userId,
		endpointId: input.endpointId,
		urlSecretHash,
	})
	if (!record) return null

	const username = await resolveOwnerUsername({
		db: input.env.APP_DB,
		userId: input.userId,
		email: input.email,
		username: input.username,
	})
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	return {
		...toPublicEndpoint(record),
		urlSecret,
		url: buildWebhookEndpointUrl({
			origin,
			username,
			endpointId: record.id,
			urlSecret,
		}),
	}
}

export async function deleteWebhookEndpointForUser(input: {
	db: D1Database
	userId: string
	endpointId: string
}): Promise<boolean> {
	return deleteWebhookEndpoint(input)
}

export async function listWebhookDeliveriesForUser(input: {
	db: D1Database
	userId: string
	endpointId: string
	limit?: number
}): Promise<Array<WebhookDeliveryRecord>> {
	const endpoint = await getWebhookEndpointByIdForUser({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
	})
	if (!endpoint) {
		throw new Error('Webhook endpoint not found.')
	}
	return listWebhookDeliveriesForEndpoint({
		db: input.db,
		userId: input.userId,
		endpointId: input.endpointId,
		limit: input.limit,
	})
}
