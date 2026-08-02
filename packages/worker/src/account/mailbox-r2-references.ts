import { type MailboxEnv } from '#worker/email/mailbox-client.ts'
import { listInternalUserEmailBlobReferences } from '#worker/email/mailbox-internal-read.ts'
import {
	type MailboxBlobReference,
	type MailboxBlobReferencePage,
} from '#worker/email/mailbox-types.ts'

export type AccountMailboxEmailObjectRef = {
	surfaceId: 'email_raw_mime' | 'email_attachment_storage_key'
	binding: 'EMAIL_BLOBS'
	key: string
}

export type AccountMailboxEmailObjectSource = {
	kind: 'mailbox_email_blob'
	startAfter: string | null
	reference: MailboxBlobReference
}

export type StableAccountMailboxEmailObjectRef =
	AccountMailboxEmailObjectRef & {
		source: AccountMailboxEmailObjectSource
	}

export function mailboxBlobReferenceToAccountObjectRef(
	reference: MailboxBlobReference,
): AccountMailboxEmailObjectRef {
	return {
		surfaceId:
			reference.kind === 'raw_mime'
				? 'email_raw_mime'
				: 'email_attachment_storage_key',
		binding: 'EMAIL_BLOBS',
		key: reference.key,
	}
}

export async function listMailboxEmailObjectRefPage(input: {
	env: MailboxEnv
	ownerId: string
	pageSize: number
	startAfter: string | null
}): Promise<{
	references: Array<StableAccountMailboxEmailObjectRef>
	nextStartAfter: string | null
	truncated: boolean
}> {
	const page = await listInternalUserEmailBlobReferences(input)
	return {
		references: page.references.map((reference) => ({
			...mailboxBlobReferenceToAccountObjectRef(reference),
			source: {
				kind: 'mailbox_email_blob',
				startAfter: input.startAfter,
				reference,
			},
		})),
		nextStartAfter: page.nextStartAfter,
		truncated: page.truncated,
	}
}

async function visitMailboxBlobReferencePages(input: {
	env: MailboxEnv
	ownerId: string
	visit: (page: MailboxBlobReferencePage) => void
}) {
	let startAfter: string | null = null
	while (true) {
		const page = await listInternalUserEmailBlobReferences({
			env: input.env,
			ownerId: input.ownerId,
			pageSize: 500,
			startAfter,
		})
		input.visit(page)
		if (!page.truncated) return
		if (page.nextStartAfter == null || page.nextStartAfter === startAfter) {
			throw new Error('Mailbox blob-reference pagination did not advance.')
		}
		startAfter = page.nextStartAfter
	}
}

export async function listAllMailboxEmailObjectRefs(input: {
	env: MailboxEnv
	ownerId: string
}): Promise<Array<AccountMailboxEmailObjectRef>> {
	const references: Array<AccountMailboxEmailObjectRef> = []
	await visitMailboxBlobReferencePages({
		...input,
		visit: (page) => {
			references.push(
				...page.references.map(mailboxBlobReferenceToAccountObjectRef),
			)
		},
	})
	return references
}

export async function countMailboxEmailObjectRefs(input: {
	env: MailboxEnv
	ownerId: string
}): Promise<number> {
	let count = 0
	await visitMailboxBlobReferencePages({
		...input,
		visit: (page) => {
			count += page.references.length
		},
	})
	return count
}

export async function resolveMailboxEmailObjectRef(input: {
	env: MailboxEnv
	ownerId: string
	source: AccountMailboxEmailObjectSource
	expectedKey: string
}): Promise<AccountMailboxEmailObjectRef | null> {
	const page = await listMailboxEmailObjectRefPage({
		env: input.env,
		ownerId: input.ownerId,
		pageSize: 1,
		startAfter: input.source.startAfter,
	})
	const current = page.references[0]
	if (!current) return null
	const actual = current.source.reference
	const expected = input.source.reference
	return actual.kind === expected.kind &&
		actual.key === expected.key &&
		actual.messageId === expected.messageId &&
		actual.attachmentId === expected.attachmentId &&
		current.key === input.expectedKey
		? current
		: null
}
