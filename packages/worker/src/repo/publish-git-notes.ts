import git from 'isomorphic-git'
import http from 'isomorphic-git/http/web'
import * as Sentry from '@sentry/cloudflare'
import { z } from 'zod'
import {
	buildArtifactsGitAuth,
	buildAuthenticatedArtifactsRemote,
	resolveArtifactSourceRepo,
} from './artifacts.ts'
import { type EntityKind } from './types.ts'

export const kodyPublishGitNoteVersion = 1 as const

export type KodyPublishGitNotePublishedBy =
	| 'repo_session'
	| 'source_bootstrap'
	| 'external_push'
	| 'source_rescue'

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

export const kodyPublishGitNotesRef = 'refs/notes/commits'

export const kodyPublishGitNoteSchema = z.object({
	v: z.literal(kodyPublishGitNoteVersion),
	publishedAt: z.string(),
	publishedBy: z.enum([
		'repo_session',
		'source_bootstrap',
		'external_push',
		'source_rescue',
	]),
	sourceId: z.string(),
	entityKind: z.enum(['skill', 'app', 'job', 'package']),
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

const kodyNoteAuthor = {
	name: 'Kody',
	email: 'kody@artifacts.local',
}

type PublishGitNoteFileSystem = {
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

class GitStat {
	readonly type: 'file' | 'directory' | 'symlink'
	readonly size: number
	readonly mtime: Date
	readonly mtimeMs: number
	readonly ctimeMs: number
	readonly ino: number
	readonly uid: number
	readonly gid: number
	readonly dev: number
	readonly mode: number

	constructor(stat: {
		type: 'file' | 'directory' | 'symlink'
		size: number
		mtime: Date
		mode?: number
	}) {
		this.type = stat.type
		this.size = stat.size
		this.mtime = stat.mtime
		this.mtimeMs = stat.mtime.getTime()
		this.ctimeMs = this.mtimeMs
		this.ino = 0
		this.uid = 0
		this.gid = 0
		this.dev = 0
		this.mode =
			stat.mode ??
			(this.type === 'directory'
				? 16_384
				: this.type === 'symlink'
					? 40_960
					: 33_188)
	}

	isFile() {
		return this.type === 'file'
	}

	isDirectory() {
		return this.type === 'directory'
	}

	isSymbolicLink() {
		return this.type === 'symlink'
	}
}

function fsError(path: string, cause: unknown) {
	if (
		cause instanceof Error &&
		'code' in cause &&
		typeof cause.code === 'string'
	) {
		return cause
	}
	const err = new Error(
		cause instanceof Error ? cause.message : `ENOENT: ${path}`,
	) as Error & { code: string }
	err.code = 'ENOENT'
	return err
}

function createIsomorphicGitFs(filesystem: PublishGitNoteFileSystem) {
	return {
		promises: {
			async readFile(path: string, options?: { encoding?: string } | string) {
				const encoding =
					typeof options === 'string' ? options : options?.encoding
				try {
					if (encoding === 'utf8' || encoding === 'utf-8') {
						return await filesystem.readFile(path)
					}
					return await filesystem.readFileBytes(path)
				} catch (error) {
					throw fsError(path, error)
				}
			},
			async writeFile(path: string, data: string | Uint8Array) {
				const parent = path.replace(/\/[^/]+$/, '')
				if (parent && parent !== '/' && parent !== path) {
					try {
						await filesystem.mkdir(parent, { recursive: true })
					} catch {
						// Parent may already exist.
					}
				}
				if (typeof data === 'string') {
					await filesystem.writeFile(path, data)
					return
				}
				await filesystem.writeFileBytes(path, data)
			},
			async unlink(path: string) {
				try {
					await filesystem.rm(path)
				} catch (error) {
					throw fsError(path, error)
				}
			},
			async readdir(path: string) {
				return filesystem.readdir(path)
			},
			async mkdir(path: string, mode?: { recursive?: boolean }) {
				await filesystem.mkdir(path, {
					recursive: typeof mode === 'object' ? mode.recursive : false,
				})
			},
			async rmdir(path: string) {
				await filesystem.rm(path)
			},
			async stat(path: string) {
				try {
					return new GitStat(await filesystem.stat(path))
				} catch (error) {
					throw fsError(path, error)
				}
			},
			async lstat(path: string) {
				try {
					return new GitStat(await filesystem.lstat(path))
				} catch (error) {
					throw fsError(path, error)
				}
			},
			async readlink(path: string) {
				try {
					return await filesystem.readlink(path)
				} catch (error) {
					throw fsError(path, error)
				}
			},
			async symlink(target: string, path: string) {
				await filesystem.symlink(target, path)
			},
			async chmod(_path: string, _mode: number) {},
		},
	}
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
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

type EphemeralGitWorkspace = {
	fs: ReturnType<typeof createIsomorphicGitFs>
	dir: string
}

function createEphemeralGitWorkspace(): EphemeralGitWorkspace {
	const store = new Map<string, Uint8Array>()
	const textDecoder = new TextDecoder()
	const textEncoder = new TextEncoder()
	const filesystem: PublishGitNoteFileSystem = {
		readFile: async (path) => {
			const bytes = store.get(path)
			if (!bytes) {
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
			}
			return textDecoder.decode(bytes)
		},
		readFileBytes: async (path) => {
			const bytes = store.get(path)
			if (!bytes) {
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
			}
			return bytes
		},
		writeFile: async (path, data) => {
			store.set(path, textEncoder.encode(data))
		},
		writeFileBytes: async (path, data) => {
			store.set(path, data)
		},
		rm: async (path, options) => {
			if (options?.recursive) {
				for (const key of [...store.keys()]) {
					if (key === path || key.startsWith(`${path}/`)) {
						store.delete(key)
					}
				}
				return
			}
			store.delete(path)
		},
		mkdir: async (path, options) => {
			if (options?.recursive) {
				const parts = path.split('/').filter(Boolean)
				let current = ''
				for (const part of parts) {
					current = `${current}/${part}`
					store.set(current, new Uint8Array())
				}
				return
			}
			store.set(path, new Uint8Array())
		},
		readdir: async (path) => {
			const prefix = path.endsWith('/') ? path : `${path}/`
			const names = new Set<string>()
			for (const key of store.keys()) {
				if (!key.startsWith(prefix)) continue
				const rest = key.slice(prefix.length)
				const [name] = rest.split('/')
				if (name) names.add(name)
			}
			return [...names]
		},
		stat: async (path) => {
			if (!store.has(path)) {
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
			}
			const isDirectory = [...store.keys()].some(
				(key) => key.startsWith(`${path}/`) && key !== path,
			)
			return {
				type: isDirectory ? ('directory' as const) : ('file' as const),
				size: store.get(path)?.byteLength ?? 0,
				mtime: new Date(),
			}
		},
		lstat: async (path) => filesystem.stat(path),
		readlink: async () => {
			throw new Error('readlink is not supported in ephemeral git workspace.')
		},
		symlink: async (target, path) => {
			await filesystem.writeFile(path, target)
		},
	}
	return {
		fs: createIsomorphicGitFs(filesystem),
		dir: '/repo',
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
	const message = error instanceof Error ? error.message : String(error)
	return /refs\/notes\/commits|could not find refs\/notes\/commits/i.test(
		message,
	)
}

export function parsePublishGitNote(raw: string): KodyPublishGitNote | null {
	const trimmed = raw.trim()
	if (!trimmed) return null
	try {
		return kodyPublishGitNoteSchema.parse(JSON.parse(trimmed))
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
	note: KodyPublishGitNote | null
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
