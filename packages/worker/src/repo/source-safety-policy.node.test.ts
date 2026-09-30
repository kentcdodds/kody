import { expect, test } from 'vitest'
import {
	assertPackagePrivateVisibilityChangeAllowed,
	assertPackageSourceOverwriteAllowed,
	assertRestorablePackageSourceSnapshot,
	buildArtifactsGitReadTimeoutMessage,
	buildPublishedCommitHeadMismatchCallerMessage,
	buildSourceRecoveryProblemMessage,
	destructiveOverwriteConfirmationField,
	isDestructiveOverwriteConfirmationMessage,
	isPrivateVisibilityChangeConfirmationMessage,
	isPublishedCommitHeadMismatchMessage,
	privateVisibilityChangeConfirmationField,
} from './source-safety-policy.ts'
import { type EntitySourceRow } from './types.ts'

function packageSource(
	overrides: Partial<EntitySourceRow> = {},
): EntitySourceRow {
	return {
		id: 'source-1',
		user_id: 'user-1',
		entity_kind: 'package',
		entity_id: 'package-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: '2026-06-06T00:00:00.000Z',
		updated_at: '2026-06-06T00:00:00.000Z',
		...overrides,
	}
}

function createEnvWithSnapshot(files: Record<string, string> | null) {
	return {
		BUNDLE_ARTIFACTS_KV: {
			async get(_key: string, type?: 'text' | 'json') {
				if (type !== 'json' || files == null) return null
				return {
					version: 1,
					sourceId: 'source-1',
					repoId: 'repo-1',
					entityKind: 'package',
					entityId: 'package-1',
					publishedCommit: 'commit-1',
					manifestPath: 'package.json',
					sourceRoot: '/',
					files,
					createdAt: '2026-06-06T00:00:00.000Z',
				}
			},
		},
	} as unknown as Env
}

function createEnvWithRawSnapshot(snapshot: unknown) {
	return {
		BUNDLE_ARTIFACTS_KV: {
			async get(_key: string, type?: 'text' | 'json') {
				return type === 'json' ? snapshot : null
			},
		},
	} as unknown as Env
}

test('published commit HEAD mismatch messages are detected for caller-error classification', () => {
	const mismatch = buildSourceRecoveryProblemMessage({
		source: packageSource({
			published_commit: 'commit-published',
			repo_id: 'package-1',
		}),
		operation: 'repoOpenSession',
		reason:
			'artifact source repo "package-1" default branch HEAD "commit-unpublished" does not match published commit "commit-published"',
	})
	expect(isPublishedCommitHeadMismatchMessage(mismatch)).toBe(true)
	expect(
		isPublishedCommitHeadMismatchMessage(
			buildSourceRecoveryProblemMessage({
				source: packageSource(),
				operation: 'repoOpenSession',
				reason: 'artifact source repo "package-1" was not found',
			}),
		),
	).toBe(false)
	expect(buildPublishedCommitHeadMismatchCallerMessage(mismatch)).toContain(
		'packagePublishExternalPush',
	)
})

test('Artifacts git timeouts name packageSave only for packageGetGitRemote', () => {
	const reason = 'Artifacts git request timed out after 8000ms.'
	expect(
		buildArtifactsGitReadTimeoutMessage({
			operation: 'packageGetGitRemote',
			reason,
		}),
	).toMatch(/packageGetGitRemote timed out[\s\S]*packageSave/)
	const session = buildArtifactsGitReadTimeoutMessage({
		operation: 'repoOpenSession',
		reason,
	})
	expect(session).toContain(
		'repoOpenSession timed out reading the Artifacts git remote.',
	)
	expect(session).not.toContain('packageSave')
})

test('package source overwrite and private-visibility changes require explicit confirmation', async () => {
	const overwriteMessage = await assertPackageSourceOverwriteAllowed({
		env: createEnvWithSnapshot({ 'package.json': '{}' }),
		userId: 'user-1',
		source: packageSource(),
		operation: 'packageSave',
	}).then(
		() => '',
		(error: Error) => error.message,
	)
	expect(overwriteMessage).toContain(destructiveOverwriteConfirmationField)
	expect(isDestructiveOverwriteConfirmationMessage(overwriteMessage)).toBe(true)
	expect(
		isDestructiveOverwriteConfirmationMessage(
			'packageSave stopped by the production package source safety policy.',
		),
	).toBe(false)

	let visibilityMessage = ''
	try {
		assertPackagePrivateVisibilityChangeAllowed({
			beforeContent: '{"name":"@x/y","private":true}',
			afterContent: '{"name":"@x/y","private":false}',
			isNewPackage: false,
			operation: 'packageSave',
		})
	} catch (error) {
		visibilityMessage = (error as Error).message
	}
	expect(visibilityMessage).toContain(privateVisibilityChangeConfirmationField)
	expect(isPrivateVisibilityChangeConfirmationMessage(visibilityMessage)).toBe(
		true,
	)
	expect(
		isPrivateVisibilityChangeConfirmationMessage(
			'packageSave would overwrite existing package source "source-1".',
		),
	).toBe(false)

	expect(() =>
		assertPackagePrivateVisibilityChangeAllowed({
			beforeContent: '{"name":"@x/y","private":true}',
			afterContent: '{"name":"@x/y"}',
			isNewPackage: false,
			operation: 'packageSave',
		}),
	).not.toThrow()
})

test('restorable package source snapshot verification rejects corrupt snapshots and accepts manifest-bearing backups', async () => {
	const assertRestorable = (env: Env, operation: string) =>
		assertRestorablePackageSourceSnapshot({
			env,
			userId: 'user-1',
			source: packageSource(),
			operation,
		})
	const forcePublish = 'packagePublishExternalPush force publish'
	const rejected: Array<[Env, string]> = [
		[
			createEnvWithSnapshot(null),
			'Stop and report this source recovery problem',
		],
		[
			createEnvWithSnapshot({ 'src/index.ts': 'export {}' }),
			'missing manifest "package.json"',
		],
		[
			createEnvWithRawSnapshot({
				version: 1,
				sourceId: 'source-1',
				publishedCommit: 'commit-1',
				files: null,
			}),
			'the published source snapshot is missing or malformed',
		],
	]
	for (const [env, message] of rejected) {
		await expect(assertRestorable(env, forcePublish)).rejects.toThrow(message)
	}

	await expect(
		assertRestorable(
			createEnvWithSnapshot({
				'package.json': '{"name":"@user/demo"}',
				'src/index.ts': 'export {}',
			}),
			'packageGetGitRemote write access',
		),
	).resolves.toEqual({
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		fileCount: 2,
	})
})
