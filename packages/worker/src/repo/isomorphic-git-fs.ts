type IsomorphicGitSourceFileSystem = {
	readFile(path: string): Promise<string>
	readFileBytes(path: string): Promise<Uint8Array>
	writeFile(path: string, data: string): Promise<void>
	writeFileBytes(path: string, data: Uint8Array): Promise<void>
	rm(path: string, options?: { recursive?: boolean }): Promise<void>
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
	readdir(path: string): Promise<Array<string>>
	stat(path: string): Promise<IsomorphicGitSourceStat>
	lstat(path: string): Promise<IsomorphicGitSourceStat>
	readlink(path: string): Promise<string>
	symlink(target: string, path: string): Promise<void>
}

type EncodingOptions = string | { encoding?: string | null } | null

type IsomorphicGitSourceStat = {
	type: 'file' | 'directory' | 'symlink'
	size: number
	mtime: Date
	mode?: number
}

class IsomorphicGitStat {
	readonly type: IsomorphicGitSourceStat['type']
	readonly size: number
	readonly mtime: Date
	readonly mtimeMs: number
	readonly ctimeMs: number
	readonly ino = 0
	readonly uid = 0
	readonly gid = 0
	readonly dev = 0
	readonly mode: number

	constructor(stat: IsomorphicGitSourceStat) {
		this.type = stat.type
		this.size = stat.size
		this.mtime = stat.mtime
		this.mtimeMs = stat.mtime.getTime()
		this.ctimeMs = this.mtimeMs
		this.mode =
			stat.mode ??
			(stat.type === 'directory'
				? 0o40755
				: stat.type === 'symlink'
					? 0o120000
					: 0o100644)
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

function toFileSystemError(path: string, cause: unknown) {
	if (
		cause instanceof Error &&
		'code' in cause &&
		typeof cause.code === 'string'
	) {
		return cause
	}
	const error = new Error(
		cause instanceof Error ? cause.message : `ENOENT: ${path}`,
	)
	Object.assign(error, { code: 'ENOENT' })
	return error
}

/**
 * Adapt the shell filesystem to the complete promise-based Node fs surface
 * isomorphic-git binds eagerly. @cloudflare/shell uses the same private
 * adapter internally, but does not export it for raw operations such as
 * pushing to a differently named ref or deleting a remote branch.
 */
export function createIsomorphicGitFs(
	fileSystem: IsomorphicGitSourceFileSystem,
) {
	return {
		promises: {
			async readFile(path: string, options?: EncodingOptions) {
				const encoding =
					typeof options === 'string' ? options : options?.encoding
				try {
					if (encoding === 'utf8' || encoding === 'utf-8') {
						return await fileSystem.readFile(path)
					}
					return await fileSystem.readFileBytes(path)
				} catch (error) {
					throw toFileSystemError(path, error)
				}
			},
			async writeFile(path: string, data: string | Uint8Array) {
				const parent = path.replace(/\/[^/]+$/, '')
				if (parent && parent !== '/' && parent !== path) {
					await fileSystem.mkdir(parent, { recursive: true })
				}
				if (typeof data === 'string') {
					await fileSystem.writeFile(path, data)
				} else {
					await fileSystem.writeFileBytes(path, data)
				}
			},
			async unlink(path: string) {
				try {
					await fileSystem.rm(path)
				} catch (error) {
					throw toFileSystemError(path, error)
				}
			},
			readdir(path: string) {
				return fileSystem.readdir(path)
			},
			mkdir(path: string, options?: number | { recursive?: boolean }) {
				return fileSystem.mkdir(path, {
					recursive: typeof options === 'object' ? options.recursive : false,
				})
			},
			rmdir(path: string) {
				return fileSystem.rm(path)
			},
			async stat(path: string) {
				try {
					return new IsomorphicGitStat(await fileSystem.stat(path))
				} catch (error) {
					throw toFileSystemError(path, error)
				}
			},
			async lstat(path: string) {
				try {
					return new IsomorphicGitStat(await fileSystem.lstat(path))
				} catch (error) {
					throw toFileSystemError(path, error)
				}
			},
			async readlink(path: string) {
				try {
					return await fileSystem.readlink(path)
				} catch (error) {
					throw toFileSystemError(path, error)
				}
			},
			symlink(target: string, path: string) {
				return fileSystem.symlink(target, path)
			},
			async chmod(_path: string, _mode: number) {},
		},
	}
}
