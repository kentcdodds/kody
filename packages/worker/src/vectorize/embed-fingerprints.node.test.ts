import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	recordVectorEmbedFingerprint,
	shouldSkipVectorEmbed,
	tryDeleteVectorEmbedFingerprint,
	tryReadVectorEmbedFingerprints,
	tryWriteVectorEmbedFingerprints,
	vectorEmbedContentHash,
	vectorEmbedFingerprintVersion,
} from './embed-fingerprints.ts'
import * as embedding from './embedding.ts'
import { reindexVectorCandidates } from './reindex-batches.ts'
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

	try {
		const candidates = [
			{
				id: 'search_memories',
				text: 'search memories capability',
				namespace: BUILTIN_VECTOR_NAMESPACE,
				metadata: { kind: 'builtin' as const },
			},
			{
				id: 'memory-1',
				text: 'remember the preview locale',
				namespace: 'user-me',
				metadata: { kind: 'memory' as const },
			},
		]

		const hash = await vectorEmbedContentHash(candidates[0]!.text)
		await expect(
			sha256Hex(
				[
					embedding.CAPABILITY_EMBEDDING_MODEL,
					String(embedding.CAPABILITY_EMBEDDING_DIMENSIONS),
					String(vectorEmbedFingerprintVersion),
					candidates[0]!.text,
				].join('\0'),
			),
		).resolves.toBe(hash)

		const longPrefix = 'x'.repeat(
			embedding.CAPABILITY_EMBEDDING_MAX_INPUT_CHARS,
		)
		await expect(vectorEmbedContentHash(`${longPrefix}tail-a`)).resolves.toBe(
			await vectorEmbedContentHash(`${longPrefix}tail-b`),
		)

		const first = await reindexVectorCandidates({
			env,
			index: { upsert } as unknown as VectorizeIndex,
			kind: 'test',
			candidates,
		})
		expect(first).toEqual({ upserted: 2 })
		expect(embedSpy).toHaveBeenCalledTimes(1)
		expect(upsert).toHaveBeenCalledTimes(1)

		embedSpy.mockClear()
		upsert.mockClear()
		const skipped = await reindexVectorCandidates({
			env,
			index: { upsert } as unknown as VectorizeIndex,
			kind: 'test',
			candidates,
		})
		expect(skipped).toEqual({ upserted: 0, skipped: 2 })
		expect(embedSpy).not.toHaveBeenCalled()
		expect(upsert).not.toHaveBeenCalled()

		await expect(
			shouldSkipVectorEmbed({
				env,
				userId: 'user-me',
				vectorId: 'memory-1',
				text: 'remember the preview locale',
			}),
		).resolves.toBe(true)
		await expect(
			shouldSkipVectorEmbed({
				env: {} as Env,
				userId: 'user-me',
				vectorId: 'memory-1',
				text: 'remember the preview locale',
			}),
		).resolves.toBe(false)

		const forced = await reindexVectorCandidates({
			env,
			index: { upsert } as unknown as VectorizeIndex,
			kind: 'test',
			candidates,
			force: true,
		})
		expect(forced).toEqual({ upserted: 2 })
		expect(embedSpy).toHaveBeenCalledTimes(1)
		expect(upsert).toHaveBeenCalledTimes(1)

		embedSpy.mockClear()
		upsert.mockClear()
		const changed = await reindexVectorCandidates({
			env,
			index: { upsert } as unknown as VectorizeIndex,
			kind: 'test',
			candidates: [
				candidates[0]!,
				{ ...candidates[1]!, text: 'remember a different locale' },
			],
		})
		expect(changed).toEqual({ upserted: 1, skipped: 1 })
		expect(embedSpy).toHaveBeenCalledTimes(1)
		expect(upsert).toHaveBeenCalledWith([
			expect.objectContaining({
				id: 'memory-1',
				namespace: 'user-me',
			}),
		])

		await recordVectorEmbedFingerprint({
			env,
			userId: 'user-me',
			vectorId: 'memory-1',
			text: 'remember a different locale',
		})
		await expect(
			shouldSkipVectorEmbed({
				env,
				userId: 'user-me',
				vectorId: 'memory-1',
				text: 'remember a different locale',
			}),
		).resolves.toBe(true)
		await tryDeleteVectorEmbedFingerprint({ env, vectorId: 'memory-1' })
		await expect(
			shouldSkipVectorEmbed({
				env,
				userId: 'user-me',
				vectorId: 'memory-1',
				text: 'remember a different locale',
			}),
		).resolves.toBe(false)

		const unmigratedEnv = {
			APP_DB: createD1FromSqlite(new DatabaseSync(':memory:')),
		} as Env
		await expect(
			tryReadVectorEmbedFingerprints({
				env: unmigratedEnv,
				keys: [{ userId: 'user-me', vectorId: 'memory-1' }],
			}),
		).resolves.toBeNull()
		await tryWriteVectorEmbedFingerprints({
			env: unmigratedEnv,
			rows: [
				{
					userId: 'user-me',
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
