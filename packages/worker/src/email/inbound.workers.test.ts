import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import {
	getEmailDomain,
	getEmailLocalPart,
	requireNormalizedEmailAddress,
} from './address.ts'
import { handleInboundEmail } from './inbound.ts'
import {
	createEmailInbox,
	createEmailInboxAddress,
	createEmailThread,
	listEmailMessages,
} from './repo.ts'
import { ensureEmailTestSchema } from './test-schema.ts'
import {
	buildPublishedSourceManifestSnapshotKvKey,
} from '#worker/package-runtime/published-runtime-artifacts.ts'

function createForwardableEmailMessage(input: {
	from: string
	to: string
	raw: string
}): ForwardableEmailMessage & { rejectedReason: string | null } {
	const encoded = new TextEncoder().encode(input.raw)
	const headers = new Headers()
	for (const line of input.raw.split(/\r?\n/)) {
		if (!line.trim()) break
		const separator = line.indexOf(':')
		if (separator <= 0) continue
		headers.append(line.slice(0, separator), line.slice(separator + 1).trim())
	}
	return {
		from: input.from,
		to: input.to,
		headers,
		raw: new Blob([encoded]).stream(),
		rawSize: encoded.byteLength,
		rejectedReason: null,
		setReject(reason: string) {
			this.rejectedReason = reason
		},
		async forward() {
			return { messageId: 'unused-forward' }
		},
		async reply() {
			return { messageId: 'unused-reply' }
		},
	}
}

test('inbound email handler stores all routed inbound messages', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-user-${crypto.randomUUID()}`
	const address = requireNormalizedEmailAddress(
		`support-${crypto.randomUUID()}@example.com`,
	)
	const inbox = await createEmailInbox({
		db: env.APP_DB,
		userId,
		name: 'Support',
		description: 'Support inbox',
	})
	await createEmailInboxAddress({
		db: env.APP_DB,
		inboxId: inbox.id,
		userId,
		address,
		localPart: getEmailLocalPart(address),
		domain: getEmailDomain(address),
	})

	const firstMessage = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: address,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${address}`,
			'Subject: Unknown sender',
			'Message-ID: <unknown@example.net>',
			'',
			'Please help.',
		].join('\r\n'),
	})
	await handleInboundEmail(firstMessage, env)
	expect(firstMessage.rejectedReason).toBeNull()

	const secondMessage = createForwardableEmailMessage({
		from: 'agent@trusted.example',
		to: address,
		raw: [
			'From: Agent <agent@trusted.example>',
			`To: ${address}`,
			'Subject: Approved sender',
			'Message-ID: <approved@trusted.example>',
			'',
			'Approved body.',
		].join('\r\n'),
	})
	await handleInboundEmail(secondMessage, env)
	expect(secondMessage.rejectedReason).toBeNull()

	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 10,
	})
	expect(messages).toHaveLength(2)
	expect(messages[0]).toMatchObject({
		fromAddress: 'agent@trusted.example',
		subject: 'Approved sender',
		processingStatus: 'stored',
	})
	expect(messages[1]).toMatchObject({
		fromAddress: 'stranger@example.net',
		subject: 'Unknown sender',
		error: null,
	})

	const normalizedExistingThread = await createEmailThread({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		subjectNormalized: 'normalized subject',
	})
	const subjectOnlyMessage = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: [
			'From: Sender <sender@example.net>',
			`To: ${address}`,
			'Subject: Re: Normalized Subject',
			'',
			'Subject-only body.',
		].join('\r\n'),
	})
	await handleInboundEmail(subjectOnlyMessage, env)
	const subjectOnly = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 1,
	})
	expect(subjectOnly[0]?.threadId).not.toBe(normalizedExistingThread.id)
})

test('inbound email handler rejects unknown aliases without persisting them', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const recipient = `missing-${crypto.randomUUID()}@example.com`
	const message = createForwardableEmailMessage({
		from: 'stranger@example.net',
		to: recipient,
		raw: [
			'From: Stranger <stranger@example.net>',
			`To: ${recipient}`,
			'Subject: Unknown alias',
			'',
			'Please help.',
		].join('\r\n'),
	})

	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toBe('Unknown Kody email alias.')
	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId: 'unknown',
		limit: 10,
	})
	expect(messages).toEqual([])
})

test('inbound email handler rejects malformed messages without persisting them', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-parse-user-${crypto.randomUUID()}`
	const address = requireNormalizedEmailAddress(
		`parse-${crypto.randomUUID()}@example.com`,
	)
	const inbox = await createEmailInbox({
		db: env.APP_DB,
		userId,
		name: 'Parse failures',
		description: 'Parse failure inbox',
	})
	await createEmailInboxAddress({
		db: env.APP_DB,
		inboxId: inbox.id,
		userId,
		address,
		localPart: getEmailLocalPart(address),
		domain: getEmailDomain(address),
	})
	const message = createForwardableEmailMessage({
		from: 'sender@example.net',
		to: address,
		raw: 'Subject: Too large\r\n\r\nBody',
	})
	Object.defineProperty(message, 'rawSize', {
		value: 600 * 1024,
	})

	await handleInboundEmail(message, env)

	expect(message.rejectedReason).toMatch(/too large/)
	const messages = await listEmailMessages({
		db: env.APP_DB,
		userId,
		inboxId: inbox.id,
		limit: 10,
	})
	expect(messages).toEqual([])
})

test('inbound email handler dispatches package subscriptions for stored inbound email', async () => {
	await ensureEmailTestSchema(env.APP_DB)
	const userId = `email-subscription-user-${crypto.randomUUID()}`
	const address = requireNormalizedEmailAddress(
		`package-inbox-${crypto.randomUUID()}@example.com`,
	)
	const sourceId = `source-${crypto.randomUUID()}`
	const packageId = `package-${crypto.randomUUID()}`
	const bundleKv = new Map<string, string>()
	const subscriptionCalls: Array<Record<string, unknown>> = []

	const db = env.APP_DB
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS saved_packages (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				name TEXT NOT NULL,
				kody_id TEXT NOT NULL,
				description TEXT NOT NULL,
				tags_json TEXT NOT NULL DEFAULT '[]',
				search_text TEXT,
				source_id TEXT NOT NULL,
				has_app INTEGER NOT NULL DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS entity_sources (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				entity_kind TEXT NOT NULL,
				entity_id TEXT NOT NULL,
				repo_id TEXT NOT NULL,
				published_commit TEXT,
				indexed_commit TEXT,
				manifest_path TEXT NOT NULL,
				source_root TEXT NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				source_id TEXT NOT NULL,
				published_commit TEXT NOT NULL,
				artifact_kind TEXT NOT NULL,
				artifact_name TEXT,
				entry_point TEXT NOT NULL,
				kv_key TEXT NOT NULL,
				dependencies_json TEXT NOT NULL DEFAULT '[]',
				created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_published_bundle_artifacts_identity
			ON published_bundle_artifacts(user_id, source_id, artifact_kind, COALESCE(artifact_name, ''), entry_point)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS package_invocations (
				id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				token_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				package_kody_id TEXT NOT NULL,
				export_name TEXT NOT NULL,
				idempotency_key TEXT NOT NULL,
				request_hash TEXT NOT NULL,
				source TEXT,
				topic TEXT,
				status TEXT NOT NULL,
				response_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_package_invocations_key
			ON package_invocations(user_id, token_id, package_id, export_name, idempotency_key)`,
		)
		.run()

	const now = new Date().toISOString()
	await db
		.prepare(
			`INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, search_text, source_id, has_app, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			packageId,
			userId,
			'@kentcdodds/package-email-notifier',
			'package-email-notifier',
			'Package email notifier',
			'[]',
			null,
			sourceId,
			0,
			now,
			now,
		)
		.run()
	await db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit, manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			sourceId,
			userId,
			'package',
			packageId,
			'repo-1',
			'commit-1',
			null,
			'package.json',
			'/',
			now,
			now,
		)
		.run()

	const manifest = {
		name: '@kentcdodds/package-email-notifier',
		exports: {
			'.': './src/index.ts',
		},
		kody: {
			id: 'package-email-notifier',
			description: 'Package email notifier',
			subscriptions: {
				'email.message.received': {
					handler: './src/email-message-received.ts',
				},
			},
		},
	}
	bundleKv.set(
		buildPublishedSourceManifestSnapshotKvKey({
			sourceId,
			publishedCommit: 'commit-1',
		}),
		JSON.stringify({
			version: 1,
			sourceId,
			publishedCommit: 'commit-1',
			manifestPath: 'package.json',
			manifestContent: JSON.stringify(manifest),
			createdAt: now,
		}),
	)

	const subscriptionArtifact = {
		version: 1,
		kind: 'module',
		artifactName: 'subscription:email.message.received',
		sourceId,
		publishedCommit: 'commit-1',
		entryPoint: 'src/email-message-received.ts',
		mainModule: 'dist/subscription.js',
		modules: {
			'.__kody_virtual__/runtime.js': `
const runtime = globalThis.__kodyRuntime ?? {};
export const email = runtime.email ?? null;
export const params = runtime.params ?? null;
`.trim(),
			'dist/subscription.js': `
import { email, params } from '../.__kody_virtual__/runtime.js'

export default async function run() {
  const result = await email.getMessage(params.message.id)
  const firstAttachment = Array.isArray(params.attachments) ? params.attachments[0] : null
  const attachment = firstAttachment?.id
    ? await email.getAttachment(firstAttachment.id)
    : null
  const attachmentText = attachment?.content_base64
    ? atob(attachment.content_base64)
    : null
  return {
    eventType: 'received',
    messageId: result.id,
    textBody: result.text_body,
    attachmentText,
  }
}
`,
		},
		dependencies: [],
		packageContext: {
			packageId,
			kodyId: 'package-email-notifier',
			sourceId,
		},
		serviceContext: null,
		createdAt: now,
	}
	const artifactJson = JSON.stringify(subscriptionArtifact)
	const artifactKey = `bundle-artifact:v1:${sourceId}:commit-1:module:subscription:email.message.received:src/email-message-received.ts`
	bundleKv.set(artifactKey, artifactJson)
	await db
		.prepare(
			`INSERT INTO published_bundle_artifacts (
				id, user_id, source_id, published_commit, artifact_kind, artifact_name, entry_point, kv_key, dependencies_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			`artifact-${crypto.randomUUID()}`,
			userId,
			sourceId,
			'commit-1',
			'module',
			'subscription:email.message.received',
			'src/email-message-received.ts',
			artifactKey,
			'[]',
			now,
			now,
		)
		.run()
	const inbox = await createEmailInbox({
		db: env.APP_DB,
		userId,
		name: 'Package inbox',
		description: 'Package-managed inbox',
		packageId,
	})
	await createEmailInboxAddress({
		db: env.APP_DB,
		inboxId: inbox.id,
		userId,
		address,
		localPart: getEmailLocalPart(address),
		domain: getEmailDomain(address),
	})

	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			subscriptionCalls.push({ waitUntil: promise })
		},
		passThroughOnException() {},
	} as ExecutionContext

	const originalKv = env.BUNDLE_ARTIFACTS_KV
	Object.assign(env, {
		BUNDLE_ARTIFACTS_KV: {
			async get(key: string, type?: string) {
				const value = bundleKv.get(key) ?? null
				if (value == null) return null
				if (type === 'json') {
					return JSON.parse(value) as unknown
				}
				return value
			},
			async put() {
				return undefined
			},
			async delete() {
				return undefined
			},
		},
	})

	try {
		const firstMessage = createForwardableEmailMessage({
			from: 'stranger@example.net',
			to: address,
			raw: [
				'From: Stranger <stranger@example.net>',
				`To: ${address}`,
				'Subject: Stored mail',
				'Message-ID: <stored@example.net>',
				'Content-Type: multipart/mixed; boundary="mail-boundary"',
				'',
				'--mail-boundary',
				'Content-Type: text/plain; charset="utf-8"',
				'',
				'Stored body.',
				'--mail-boundary',
				'Content-Type: text/plain; name="note.txt"',
				'Content-Disposition: attachment; filename="note.txt"',
				'',
				'Attachment text',
				'--mail-boundary--',
			].join('\r\n'),
		})
		await handleInboundEmail(firstMessage, env, ctx)
		expect(firstMessage.rejectedReason).toBeNull()

		const secondMessage = createForwardableEmailMessage({
			from: 'agent@trusted.example',
			to: address,
			raw: [
				'From: Agent <agent@trusted.example>',
				`To: ${address}`,
				'Subject: Approved sender',
				'Message-ID: <approved@trusted.example>',
				'',
				'Approved body.',
			].join('\r\n'),
		})
		await handleInboundEmail(secondMessage, env, ctx)
		expect(secondMessage.rejectedReason).toBeNull()

		for (const entry of subscriptionCalls) {
			if (entry['waitUntil'] instanceof Promise) {
				await entry['waitUntil']
			}
		}

		const invocations = await db
			.prepare(
				`SELECT export_name, topic, source, response_json
				FROM package_invocations
				WHERE package_id = ?
				ORDER BY created_at ASC, id ASC`,
			)
			.bind(packageId)
			.all<Record<string, unknown>>()
		expect(invocations.results).toHaveLength(2)
		const responses = (invocations.results ?? []).map((row) =>
			JSON.parse(String(row['response_json'])),
		) as Array<{ status: number; body: Record<string, unknown> }>
		expect(invocations.results?.map((row) => row['export_name'])).toEqual([
			'subscription:email.message.received',
			'subscription:email.message.received',
		])
		expect(invocations.results?.map((row) => row['topic'])).toEqual([
			'email.message.received',
			'email.message.received',
		])
		expect(invocations.results?.map((row) => row['source'])).toEqual([
			'email',
			'email',
		])
		expect(responses[0]?.body).toMatchObject({
			ok: true,
			result: {
				eventType: 'received',
				textBody: 'Stored body.\n',
				attachmentText: 'Attachment text\n',
			},
		})
		expect(responses[1]?.body).toMatchObject({
			ok: true,
			result: {
				eventType: 'received',
				textBody: 'Approved body.\n',
				attachmentText: null,
			},
		})
	} finally {
		Object.assign(env, {
			BUNDLE_ARTIFACTS_KV: originalKv,
		})
	}
})
