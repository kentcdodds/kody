import { expect, test, vi } from 'vitest'
import { type MailboxBlobReference } from '#worker/email/mailbox-types.ts'
import type * as MailboxInternalReadModule from '#worker/email/mailbox-internal-read.ts'

const mocks = vi.hoisted(() => ({
	listInternalUserEmailBlobReferences: vi.fn(),
}))

vi.mock('#worker/email/mailbox-internal-read.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxInternalReadModule>()
	return {
		...actual,
		listInternalUserEmailBlobReferences:
			mocks.listInternalUserEmailBlobReferences,
	}
})

const {
	countMailboxEmailObjectRefs,
	listAllMailboxEmailObjectRefs,
	listMailboxEmailObjectRefPage,
	resolveMailboxEmailObjectRef,
} = await import('./mailbox-r2-references.ts')

test('Mailbox R2 helpers share pagination, mapping, and revalidation semantics', async () => {
	const raw: MailboxBlobReference = {
		kind: 'raw_mime',
		key: 'email-raw:v1:user-a/message-a',
		messageId: 'message-a',
		attachmentId: null,
	}
	const attachment: MailboxBlobReference = {
		kind: 'attachment',
		key: 'email-attachment:v1:user-a/message-a/attachment-a',
		messageId: 'message-a',
		attachmentId: 'attachment-a',
	}
	mocks.listInternalUserEmailBlobReferences.mockImplementation(
		async ({ startAfter }: { startAfter?: string | null }) =>
			startAfter == null
				? {
						references: [raw],
						nextStartAfter: 'raw_mime:message-a',
						truncated: true,
					}
				: {
						references: [attachment],
						nextStartAfter: null,
						truncated: false,
					},
	)
	const env = {} as Env

	expect(
		await listAllMailboxEmailObjectRefs({ env, ownerId: 'user-a' }),
	).toEqual([
		{
			surfaceId: 'email_raw_mime',
			binding: 'EMAIL_BLOBS',
			key: raw.key,
		},
		{
			surfaceId: 'email_attachment_storage_key',
			binding: 'EMAIL_BLOBS',
			key: attachment.key,
		},
	])
	expect(await countMailboxEmailObjectRefs({ env, ownerId: 'user-a' })).toBe(2)

	const page = await listMailboxEmailObjectRefPage({
		env,
		ownerId: 'user-a',
		pageSize: 1,
		startAfter: null,
	})
	const stableRef = page.references[0]!
	expect(stableRef).toMatchObject({
		surfaceId: 'email_raw_mime',
		key: raw.key,
		source: { startAfter: null, reference: raw },
	})
	expect(
		await resolveMailboxEmailObjectRef({
			env,
			ownerId: 'user-a',
			source: stableRef.source,
			expectedKey: stableRef.key,
		}),
	).toMatchObject({ key: raw.key })
	expect(
		await resolveMailboxEmailObjectRef({
			env,
			ownerId: 'user-a',
			source: stableRef.source,
			expectedKey: 'changed-key',
		}),
	).toBeNull()
})

test('Mailbox R2 pagination fails closed when a cursor does not advance', async () => {
	mocks.listInternalUserEmailBlobReferences.mockResolvedValue({
		references: [],
		nextStartAfter: null,
		truncated: true,
	})
	await expect(
		countMailboxEmailObjectRefs({
			env: {} as Env,
			ownerId: 'user-a',
		}),
	).rejects.toThrow('pagination did not advance')
})
