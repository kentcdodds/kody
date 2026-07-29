import { getAppBaseUrl } from '#app/app-base-url.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import {
	listPackageWebhooks,
	type PackageWebhookManifestEntry,
} from '#worker/package-registry/manifest.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { generateWebhookUrlSecret, hashWebhookUrlSecret } from './crypto.ts'
import { buildWebhookEndpointUrl } from './public-url.ts'
import {
	getWebhookEndpointByKey,
	listWebhookEndpointsForUser,
	setWebhookEndpointEnabled,
	upsertWebhookEndpointSecret,
} from './repo.ts'
import { type WebhookEndpointRecord } from './types.ts'

export type ListedWebhook = {
	packageId: string
	packageKodyId: string
	packageName: string
	name: string
	exportName: string
	description: string | null
	responseMode: 'ack' | 'sync'
	verification: PackageWebhookManifestEntry['verification']
	minted: boolean
	enabled: boolean | null
	createdAt: string | null
	rotatedAt: string | null
}

export type MintedWebhookUrl = {
	packageId: string
	packageKodyId: string
	name: string
	url: string
	urlSecret: string
	enabled: boolean
	createdAt: string
	rotatedAt: string
}

async function resolveOwnerUsername(input: {
	db: D1Database
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
			'A public username is required to mint webhook endpoint URLs.',
		)
	}
	return resolved
}

async function resolveOwnedPackage(input: {
	db: D1Database
	userId: string
	packageId?: string
	kodyId?: string
}): Promise<SavedPackageRecord> {
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

async function loadDeclaredWebhook(input: {
	env: Env
	baseUrl: string
	userId: string
	savedPackage: SavedPackageRecord
	webhookName: string
}): Promise<PackageWebhookManifestEntry> {
	const loaded = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	const declared = listPackageWebhooks(loaded.manifest).find(
		(webhook) => webhook.name === input.webhookName,
	)
	if (!declared) {
		throw new Error(
			`Package "${input.savedPackage.kodyId}" does not declare webhook "${input.webhookName}".`,
		)
	}
	return declared
}

export async function listWebhooksForUser(input: {
	env: Env
	baseUrl: string
	userId: string
	packageId?: string
	kodyId?: string
}): Promise<Array<ListedWebhook>> {
	const packages = await listSavedPackagesByUserId(input.env.APP_DB, {
		userId: input.userId,
	})
	const packageFilter = (input.packageId ?? input.kodyId ?? '').trim()
	const filteredPackages = packageFilter
		? packages.filter(
				(entry) => entry.id === packageFilter || entry.kodyId === packageFilter,
			)
		: packages

	const mintedByKey = new Map<string, WebhookEndpointRecord>()
	for (const mint of await listWebhookEndpointsForUser({
		db: input.env.APP_DB,
		userId: input.userId,
	})) {
		mintedByKey.set(`${mint.packageId}:${mint.webhookName}`, mint)
	}

	const listed: Array<ListedWebhook> = []
	for (const savedPackage of filteredPackages) {
		const loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceId: savedPackage.sourceId,
		}).catch((error) => {
			console.warn('Failed to load package manifest for webhooks', {
				packageId: savedPackage.id,
				sourceId: savedPackage.sourceId,
				error,
			})
			return null
		})
		if (!loaded) continue
		for (const webhook of listPackageWebhooks(loaded.manifest)) {
			const mint = mintedByKey.get(`${savedPackage.id}:${webhook.name}`)
			listed.push({
				packageId: savedPackage.id,
				packageKodyId: savedPackage.kodyId,
				packageName: savedPackage.name,
				name: webhook.name,
				exportName: webhook.exportName,
				description: webhook.description,
				responseMode: webhook.responseMode,
				verification: webhook.verification,
				minted: mint !== undefined,
				enabled: mint?.enabled ?? null,
				createdAt: mint?.createdAt ?? null,
				rotatedAt: mint?.rotatedAt ?? null,
			})
		}
	}

	return listed.sort(
		(left, right) =>
			left.packageKodyId.localeCompare(right.packageKodyId) ||
			left.name.localeCompare(right.name),
	)
}

export async function mintWebhookUrlForUser(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	packageId?: string
	kodyId?: string
	webhookName: string
	requestUrl?: string | null
	/** When false, rotate secret without forcing enabled=true on conflict. */
	activate?: boolean
}): Promise<MintedWebhookUrl> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new Error('webhookName is required.')
	const activate = input.activate !== false
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	await loadDeclaredWebhook({
		env: input.env,
		baseUrl,
		userId: input.userId,
		savedPackage,
		webhookName,
	})

	const urlSecret = await generateWebhookUrlSecret()
	const urlSecretHash = await hashWebhookUrlSecret(urlSecret)
	const record = await upsertWebhookEndpointSecret({
		db: input.env.APP_DB,
		id: crypto.randomUUID(),
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
		urlSecretHash,
		enabled: true,
		updateEnabledOnConflict: activate,
	})

	const username = await resolveOwnerUsername({
		db: input.env.APP_DB,
		email: input.email,
		username: input.username,
	})
	return {
		packageId: savedPackage.id,
		packageKodyId: savedPackage.kodyId,
		name: webhookName,
		urlSecret,
		url: buildWebhookEndpointUrl({
			origin: baseUrl,
			username,
			packageKodyId: savedPackage.kodyId,
			webhookName,
			urlSecret,
		}),
		enabled: record.enabled,
		createdAt: record.createdAt,
		rotatedAt: record.rotatedAt,
	}
}

export async function rotateWebhookUrlForUser(input: {
	env: Env
	userId: string
	email?: string | null
	username?: string | null
	packageId?: string
	kodyId?: string
	webhookName: string
	requestUrl?: string | null
}): Promise<MintedWebhookUrl> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new Error('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	const existing = await getWebhookEndpointByKey({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
	})
	if (!existing) {
		throw new Error(
			'Webhook URL has not been minted. Call webhook_url_mint first.',
		)
	}
	return mintWebhookUrlForUser({
		...input,
		activate: false,
	})
}

export async function setWebhookEnabledForUser(input: {
	env: Env
	userId: string
	packageId?: string
	kodyId?: string
	webhookName: string
	enabled: boolean
}): Promise<WebhookEndpointRecord> {
	const webhookName = input.webhookName.trim()
	if (!webhookName) throw new Error('webhookName is required.')
	const savedPackage = await resolveOwnedPackage({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: input.packageId,
		kodyId: input.kodyId,
	})
	const updated = await setWebhookEndpointEnabled({
		db: input.env.APP_DB,
		userId: input.userId,
		packageId: savedPackage.id,
		webhookName,
		enabled: input.enabled,
	})
	if (!updated) {
		throw new Error(
			'Webhook URL has not been minted. Call webhook_url_mint first.',
		)
	}
	return updated
}
