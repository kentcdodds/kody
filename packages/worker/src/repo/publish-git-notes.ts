import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	resolveArtifactSourceRepo,
} from './artifacts.ts'
import {
	createEphemeralGitWorkspace,
	createIsomorphicGitFs,
} from './ephemeral-git-workspace.ts'
import { entityKindValues, type EntityKind } from './types.ts'

export const kodyPublishGitNoteVersion = 1 as const

export type KodyPublishGitNotePublishedBy =
	| 'repo_session'
	| 'source_bootstrap'
	| 'external_push'

export type KodyPublishGitNoteChecks = {
	runId: string
	treeHash: string | null
	checkedAt: string | null
	ok: boolean
	results: Array<{
		kind: string
		ok: boolean
		message: string
	}>
}

export type KodyPublishGitNote = {
	v: typeof kodyPublishGitNoteVersion
	publishedAt: string
	publishedBy: KodyPublishGitNotePublishedBy
	sourceId: string
	entityKind: EntityKind
	entityId: string
	repoId: string
	commit: string
	sessionId?: string | null
	conversationId?: string | null
	previousPublishedCommit?: string | null
	baseCommit?: string | null
	checks?: KodyPublishGitNoteChecks | null
}

type LegacyPublishEntityKind = 'skill' | 'app'

export type ParsedKodyPublishGitNote = Omit<
	KodyPublishGitNote,
	'entityKind'
> & {
	entityKind: EntityKind | LegacyPublishEntityKind
}

export const kodyPublishGitNotesRef = 'refs/notes/commits'

export const kodyPublishGitNoteSchema = z.object({
	v: z.literal(kodyPublishGitNoteVersion),
	publishedAt: z.string(),
	publishedBy: z.enum(['repo_session', 'source_bootstrap', 'external_push']),
	sourceId: z.string(),
	entityKind: z.enum(entityKindValues),
	entityId: z.string(),
	repoId: z.string(),
	commit: z.string(),
	sessionId: z.string().nullable().optional(),
	conversationId: z.string().nullable().optional(),
	previousPublishedCommit: z.string().nullable().optional(),
	baseCommit: z.string().nullable().optional(),
	checks: z
		.object({
			runId: z.string(),
			treeHash: z.string().nullable(),
			checkedAt: z.string().nullable(),
			ok: z.boolean(),
			results: z.array(
				z.object({
					kind: z.string(),
					ok: z.boolean(),
					message: z.string(),
				}),
			),
		})
		.nullable()
		.optional(),
})

export const legacyKodyPublishGitNoteSchema = kodyPublishGitNoteSchema.extend({
	entityKind: z.enum(['skill', 'app', ...entityKindValues]),
})

const kodyNoteAuthor = {
	name: 'Kody',
	email: 'kody@artifacts.local',
}

export type PublishGitNoteFileSystem = {
	readFile(path: string): Promise<string>
	readFileBytes(path: string): Promise<Uint8Array>
	writeFile(path: string, data: string): Promise<void>
	writeFileBytes(path: string, data: Uint8Array): Promise<void>
	rm(path: string, options?: { recursive?: boolean }): Promise<void>
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
	readdir(path: string): Promise<Array<string>>
	stat(path: string): Promise<{
		type: 'file' | 'directory' | 'symlink'
		size: number
		mtime: Date
		mode?: number
	}>
	lstat(path: string): Promise<{
		type: 'file' | 'directory' | 'symlink'
		size: number
		mtime: Date
		mode?: number
	}>
	readlink(path: string): Promise<string>
	symlink(target: string, path: string): Promise<void>
}

export function buildPublishGitNote(input: {
	publishedBy: KodyPublishGitNotePublishedBy
	source: {
		id: string
		entity_kind: EntityKind
		entity_id: string
		repo_id: string
		published_commit: string | null
	}
	commit: string
	publishedAt?: string
	sessionId?: string | null
	conversationId?: string | null
	baseCommit?: string | null
	previousPublishedCommit?: string | null
	checks?: KodyPublishGitNoteChecks | null
}): KodyPublishGitNote {
	return {
		v: kodyPublishGitNoteVersion,
		publishedAt: input.publishedAt ?? new Date().toISOString(),
		publishedBy: input.publishedBy,
		sourceId: input.source.id,
		entityKind: input.source.entity_kind,
		entityId: input.source.entity_id,
		repoId: input.source.repo_id,
		commit: input.commit,
		sessionId: input.sessionId ?? null,
		conversationId: input.conversationId ?? null,
		previousPublishedCommit:
			input.previousPublishedCommit !== undefined
				? input.previousPublishedCommit
				: input.source.published_commit,
		baseCommit: input.baseCommit ?? null,
		checks: input.checks ?? null,
	}
}

export async function writeAndPushPublishGitNote(input: {
	filesystem: PublishGitNoteFileSystem
	dir: string
	commitOid: string
	remote: string
	token: string
	remoteName?: string
	note: KodyPublishGitNote
}) {
	const fs = createIsomorphicGitFs(input.filesystem)
	const remoteName = input.remoteName ?? 'source'
	const onAuth = () => buildArtifactsGitAuth({ token: input.token })
	try {
		await git.fetch({
			fs,
			http,
			dir: input.dir,
			remote: remoteName,
			url: input.remote,
			ref: kodyPublishGitNotesRef,
			onAuth,
		})
	} catch (error) {
		if (!isMissingPublishGitNoteError(error)) {
			throw error
		}
	}
	const noteText = `${JSON.stringify(input.note, null, 2)}\n`
	await git.addNote({
		fs,
		dir: input.dir,
		ref: kodyPublishGitNotesRef,
		oid: input.commitOid,
		note: noteText,
		force: true,
		author: kodyNoteAuthor,
		committer: kodyNoteAuthor,
	})
	await git.push({
		fs,
		http,
		dir: input.dir,
		remote: remoteName,
		url: input.remote,
		ref: kodyPublishGitNotesRef,
		remoteRef: kodyPublishGitNotesRef,
		force: true,
		onAuth,
	})
}

export async function attachPublishGitNoteBestEffort(input: {
	filesystem: PublishGitNoteFileSystem
	dir: string
	commitOid: string
	remote: string
	token: string
	remoteName?: string
	note: KodyPublishGitNote
	scope: string
}) {
	try {
		await writeAndPushPublishGitNote(input)
	} catch (error) {
		Sentry.captureException(error, {
			tags: { scope: input.scope },
			extra: {
				sourceId: input.note.sourceId,
				commit: input.note.commit,
				publishedBy: input.note.publishedBy,
			},
		})
		console.warn('publish_git_note failed', {
			scope: input.scope,
			sourceId: input.note.sourceId,
			commit: input.note.commit,
			publishedBy: input.note.publishedBy,
			error: getErrorMessage(error),
		})
	}
}

function isMissingPublishGitNoteError(error: unknown) {
	if (
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		error.code === 'NotFoundError'
	) {
		return true
	}
	const message = getErrorMessage(error)
	return /refs\/notes\/commits|could not find refs\/notes\/commits/i.test(
		message,
	)
}

export function parsePublishGitNote(
	raw: string,
): ParsedKodyPublishGitNote | null {
	const trimmed = raw.trim()
	if (!trimmed) return null
	try {
		return legacyKodyPublishGitNoteSchema.parse(JSON.parse(trimmed))
	} catch {
		return null
	}
}

export async function readPublishGitNoteFromArtifactsRepo(input: {
	env: Env
	repoId: string
	commitOid: string
}): Promise<{
	found: boolean
	commit: string
	rawNote: string | null
	note: ParsedKodyPublishGitNote | null
}> {
	const repo = await resolveArtifactSourceRepo(input.env, input.repoId)
	const info = await repo.info()
	if (!info?.remote) {
		throw new Error('Artifact repo remote URL is unavailable.')
	}
	const token = await repo.createToken('read', 300)
	const remote = buildAuthenticatedArtifactsRemote({
		remote: info.remote,
		token: token.plaintext,
	})
	const workspace = createEphemeralGitWorkspace()
	const auth = buildArtifactsGitAuth({ token: token.plaintext })
	await git.clone({
		fs: workspace.fs,
		http,
		dir: workspace.dir,
		url: remote,
		depth: 1,
		singleBranch: true,
		ref: info.defaultBranch || 'main',
		onAuth() {
			return auth
		},
	})
	try {
		await git.fetch({
			fs: workspace.fs,
			http,
			dir: workspace.dir,
			remote: 'origin',
			ref: kodyPublishGitNotesRef,
			onAuth() {
				return auth
			},
		})
	} catch (error) {
		if (!isMissingPublishGitNoteError(error)) {
			throw error
		}
		return {
			found: false,
			commit: input.commitOid,
			rawNote: null,
			note: null,
		}
	}
	try {
		const noteBytes = await git.readNote({
			fs: workspace.fs,
			dir: workspace.dir,
			ref: kodyPublishGitNotesRef,
			oid: input.commitOid,
		})
		const rawNote = new TextDecoder().decode(noteBytes)
		return {
			found: true,
			commit: input.commitOid,
			rawNote,
			note: parsePublishGitNote(rawNote),
		}
	} catch (error) {
		if (!isMissingPublishGitNoteError(error)) {
			throw error
		}
		return {
			found: false,
			commit: input.commitOid,
			rawNote: null,
			note: null,
		}
	}
}
