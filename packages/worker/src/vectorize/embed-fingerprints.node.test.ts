import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	canonicalizeVectorEmbedMetadata,
	recordVectorEmbedFingerprint,
	shouldSkipVectorEmbed,
	tryDeleteVectorEmbedFingerprint,
	tryReadVectorEmbedFingerprints,
	tryWriteVectorEmbedFingerprints,
	vectorEmbedContentHash,
	vectorEmbedFingerprintVersion,
} from './embed-fingerprints.ts'
import * as embedding from './embedding.ts'
import {
	reindexVectorCandidates,
	type VectorReindexCandidate,
} from './reindex-batches.ts'
import { BUILTIN_VECTOR_NAMESPACE } from './vector-namespaces.ts'

function createMigratedDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	return createD1FromSqlite(sqlite)
}

test('vector embed fingerprints skip unchanged text and force rebuilds Vectorize', async () => {
	const env = { APP_DB: createMigratedDb() } as Env
	const upsert = vi.fn(async () => {})
	const embedSpy = vi
		.spyOn(embedding, 'embedTextsForVectorize')
		.mockImplementation(async (_env, texts) =>
			texts.map((text) => [text.length]),
		)
	const builtin: VectorReindexCandidate = {
		id: 'search_memories',
		text: 'search memories capability',
		namespace: BUILTIN_VECTOR_NAMESPACE,
		metadata: { kind: 'builtin' },
	}
	const memory: VectorReindexCandidate = {
		id: 'memory-1',
		text: 'remember the preview locale',
		namespace: 'user-me',
		metadata: { kind: 'memory' },
	}
	const reindex = (candidates: VectorReindexCandidate[], force?: boolean) => {
		embedSpy.mockClear()
		upsert.mockClear()
		return reindexVectorCandidates({
			env,
			index: { upsert } as unknown as VectorizeIndex,
			kind: 'test',
			candidates,
			force,
		})
	}
	const skip = (
		text: string,
		metadata?: Record<string, VectorizeVectorMetadata>,
		skipEnv = env,
	) =>
		shouldSkipVectorEmbed({
			env: skipEnv,
			userId: ownerIdFromStored('user-me'),
			vectorId: 'memory-1',
			text,
			metadata,
		})

	try {
		await expect(
			sha256Hex(
				[
					embedding.CAPABILITY_EMBEDDING_MODEL,
					String(embedding.CAPABILITY_EMBEDDING_DIMENSIONS),
					String(vectorEmbedFingerprintVersion),
					builtin.text,
					canonicalizeVectorEmbedMetadata(builtin.metadata),
				].join('\0'),
			),
		).resolves.toBe(
			await vectorEmbedContentHash({
				text: builtin.text,
				metadata: builtin.metadata,
			}),
		)

		const longPrefix = 'x'.repeat(
			embedding.CAPABILITY_EMBEDDING_MAX_INPUT_CHARS,
		)
		await expect(
			vectorEmbedContentHash({ text: `${longPrefix}tail-a` }),
		).resolves.toBe(
			await vectorEmbedContentHash({ text: `${longPrefix}tail-b` }),
		)

		for (const [force, expected] of [
			[false, { upserted: 2 }],
			[false, { upserted: 0, skipped: 2 }],
		] as const) {
			await expect(reindex([builtin, memory], force)).resolves.toEqual(expected)
			const calls = expected.upserted ? 1 : 0
			expect(embedSpy).toHaveBeenCalledTimes(calls)
			expect(upsert).toHaveBeenCalledTimes(calls)
		}

		await expect(skip(memory.text, { kind: 'memory' })).resolves.toBe(true)
		await expect(
			skip(memory.text, { kind: 'memory', status: 'deleted' }),
		).resolves.toBe(false)
		await expect(
			skip(memory.text, { kind: 'memory' }, {} as Env),
		).resolves.toBe(false)

		await expect(reindex([builtin, memory], true)).resolves.toEqual({
			upserted: 2,
		})
		expect(embedSpy).toHaveBeenCalledTimes(1)
		expect(upsert).toHaveBeenCalledTimes(1)

		const changedText = { ...memory, text: 'remember a different locale' }
		await expect(reindex([builtin, changedText])).resolves.toEqual({
			upserted: 1,
			skipped: 1,
		})
		expect(embedSpy).toHaveBeenCalledTimes(1)
		expect(upsert).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'memory-1', namespace: 'user-me' }),
		])

		const deletedMetadata = { kind: 'memory', status: 'deleted' }
		await expect(
			reindex([builtin, { ...changedText, metadata: deletedMetadata }]),
		).resolves.toEqual({ upserted: 1, skipped: 1 })
		expect(embedSpy).toHaveBeenCalledTimes(1)
		expect(upsert).toHaveBeenCalledWith([
			expect.objectContaining({ id: 'memory-1', metadata: deletedMetadata }),
		])

		await recordVectorEmbedFingerprint({
			env,
			userId: ownerIdFromStored('user-me'),
			vectorId: 'memory-1',
			text: changedText.text,
		})
		await expect(skip(changedText.text)).resolves.toBe(true)
		await tryDeleteVectorEmbedFingerprint({ env, vectorId: 'memory-1' })
		await expect(skip(changedText.text)).resolves.toBe(false)

		const unmigratedEnv = {
			APP_DB: createD1FromSqlite(new DatabaseSync(':memory:')),
		} as Env
		await expect(
			tryReadVectorEmbedFingerprints({
				env: unmigratedEnv,
				keys: [{ userId: ownerIdFromStored('user-me'), vectorId: 'memory-1' }],
			}),
		).resolves.toBeNull()
		await tryWriteVectorEmbedFingerprints({
			env: unmigratedEnv,
			rows: [
				{
					userId: ownerIdFromStored('user-me'),
					vectorId: 'memory-1',
					contentHash: 'abc',
				},
			],
		})
		await tryDeleteVectorEmbedFingerprint({
			env: unmigratedEnv,
			vectorId: 'memory-1',
		})
	} finally {
		embedSpy.mockRestore()
	}
})
