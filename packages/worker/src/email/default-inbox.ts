import {
	createEmailInbox,
	createEmailInboxAddress,
	getEmailInboxAddressByAddress,
	getEmailInboxById,
	getEmailInboxByName,
} from './repo.ts'
import { buildPlatformEmailAddress } from './platform-address.ts'
import { type EmailInboxAddressRecord, type EmailInboxRecord } from './types.ts'

export const defaultEmailInboxName = 'default'

export type ProvisionedDefaultInbox = {
	inbox: EmailInboxRecord
	address: EmailInboxAddressRecord
}

/**
 * Ensure the user's automatic default inbox at `{username}@<platform domain>`
 * exists. Idempotent and race-tolerant: signup provisioning and
 * first-inbound provisioning may run concurrently, so each insert falls back
 * to re-reading the row another writer created. Returns null when the
 * address is already claimed by a different user's legacy alias row.
 */
export async function ensureDefaultEmailInbox(input: {
	db: D1Database
	userId: string
	username: string
	domain: string
}): Promise<ProvisionedDefaultInbox | null> {
	const address = buildPlatformEmailAddress({
		username: input.username,
		domain: input.domain,
	})

	const readExisting = async () => {
		const existingAddress = await getEmailInboxAddressByAddress({
			db: input.db,
			address,
		})
		if (!existingAddress) return null
		if (existingAddress.userId !== input.userId) {
			return { conflict: true as const }
		}
		const inbox = await getEmailInboxById({
			db: input.db,
			userId: input.userId,
			id: existingAddress.inboxId,
		})
		if (!inbox) return { conflict: true as const }
		return { conflict: false as const, inbox, address: existingAddress }
	}

	const existing = await readExisting()
	if (existing) {
		return existing.conflict
			? null
			: { inbox: existing.inbox, address: existing.address }
	}

	let inbox = await getEmailInboxByName({
		db: input.db,
		userId: input.userId,
		name: defaultEmailInboxName,
	})
	if (!inbox) {
		try {
			inbox = await createEmailInbox({
				db: input.db,
				userId: input.userId,
				name: defaultEmailInboxName,
				description: `Automatic inbox for ${address}`,
			})
		} catch (error) {
			inbox = await getEmailInboxByName({
				db: input.db,
				userId: input.userId,
				name: defaultEmailInboxName,
			})
			if (!inbox) throw error
		}
	}

	try {
		const created = await createEmailInboxAddress({
			db: input.db,
			inboxId: inbox.id,
			userId: input.userId,
			address,
			localPart: input.username.trim().toLowerCase(),
			domain: input.domain,
		})
		return { inbox, address: created }
	} catch (error) {
		const raced = await readExisting()
		if (raced) {
			return raced.conflict
				? null
				: { inbox: raced.inbox, address: raced.address }
		}
		throw error
	}
}
