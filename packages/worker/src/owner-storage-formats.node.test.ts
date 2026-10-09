import { expect, test } from 'vitest'
import {
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { buildUserAvatarR2Key } from '#worker/community/avatar.ts'
import { emailRawMimeKey } from '#worker/email/blob-keys.ts'
import { mcpClientHubKey } from '#worker/mcp-client/hub-client.ts'
import {
	userIntegrationCredentialContext,
	userMcpEventSubscriptionSecretContext,
	userOauthAppCredentialContext,
	userSecretContext,
	userWebhookHmacSecretContext,
	userWebhookUrlSecretContext,
} from '#mcp/secrets/crypto.ts'
import { vectorEmbedFingerprintKey } from '#worker/vectorize/embed-fingerprints.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import {
	jobManagerDurableObjectName,
	mailboxDurableObjectName,
	mcpClientHubDurableObjectName,
	packageRealtimeSessionDurableObjectName,
	repoSessionIndexDurableObjectName,
	runLogDurableObjectName,
	storageRunnerDurableObjectName,
	stripePlanRefreshDurableObjectName,
	userMeterDurableObjectName,
} from '#worker/user-scoped-durable-object-name.ts'

// Existing data is keyed by these exact strings. A personal org reuses the
// person's stable id, so every format must keep producing the same value for
// an owner as it did for that person's stable user id.
const stableId = '0123456789abcdef'.repeat(4)
const owner = personalOrgId(personIdFromStored(stableId))

test('a personal org id is the stable user id it replaces', () => {
	expect(owner).toBe(stableId)
})

test('owner-keyed Durable Object names are frozen', () => {
	expect({
		jobManager: jobManagerDurableObjectName(owner),
		runLog: runLogDurableObjectName(owner),
		userMeter: userMeterDurableObjectName(owner),
		stripePlanRefresh: stripePlanRefreshDurableObjectName(owner),
		mailbox: mailboxDurableObjectName(owner),
		repoSessionIndex: repoSessionIndexDurableObjectName(owner),
		mcpClientHub: mcpClientHubDurableObjectName(owner),
		storageRunner: storageRunnerDurableObjectName(owner, 'job:1'),
		packageRealtimeSession: packageRealtimeSessionDurableObjectName({
			userId: owner,
			packageId: 'pkg-1',
		}),
	}).toEqual({
		jobManager: stableId,
		runLog: stableId,
		userMeter: stableId,
		stripePlanRefresh: stableId,
		mailbox: stableId,
		repoSessionIndex: stableId,
		mcpClientHub: stableId,
		storageRunner: `["${stableId}","job:1"]`,
		packageRealtimeSession: `["${stableId}","pkg-1"]`,
	})
})

test('owner-keyed secret AAD contexts are frozen', () => {
	expect([
		userSecretContext(owner),
		userIntegrationCredentialContext(owner, 'github'),
		userOauthAppCredentialContext(owner, 'my-app'),
		userWebhookUrlSecretContext(owner, 'endpoint-1'),
		userWebhookHmacSecretContext(owner, 'endpoint-1'),
		userMcpEventSubscriptionSecretContext(owner, 'sub-1'),
	]).toEqual([
		`user:${stableId}`,
		`user:${stableId}:integration:github`,
		`user:${stableId}:oauth-app:my-app`,
		`user:${stableId}:webhook-endpoint:endpoint-1`,
		`user:${stableId}:webhook-endpoint:endpoint-1:hmac`,
		`user:${stableId}:mcp-event-subscription:sub-1`,
	])
})

test('owner-keyed R2 keys, KV keys, and Vectorize namespaces are frozen', () => {
	expect({
		avatar: buildUserAvatarR2Key({
			stableUserId: owner,
			contentHash: 'abc',
			contentType: 'image/png',
		}),
		emailRawMime: emailRawMimeKey(owner, 'msg-1'),
		embedFingerprint: vectorEmbedFingerprintKey(owner, 'vec-1'),
		mcpClientHub: mcpClientHubKey(owner),
		vectorNamespace: userVectorNamespace(owner),
	}).toEqual({
		avatar: `user-avatars/${stableId}/abc.png`,
		emailRawMime: `email-raw:v1:${stableId}/msg-1`,
		embedFingerprint: `${stableId}\0vec-1`,
		mcpClientHub: stableId,
		vectorNamespace: stableId,
	})
})
