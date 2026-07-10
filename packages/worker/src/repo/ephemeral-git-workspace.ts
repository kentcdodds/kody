type EphemeralGitFileSystem = {
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
	const error = new Error(
		cause instanceof Error ? cause.message : `ENOENT: ${path}`,
	) as Error & { code: string }
	error.code = 'ENOENT'
	return error
}

export function createIsomorphicGitFs(filesystem: EphemeralGitFileSystem) {
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

export function createEphemeralGitWorkspace() {
	const store = new Map<string, Uint8Array>()
	const textDecoder = new TextDecoder()
	const textEncoder = new TextEncoder()
	const filesystem: EphemeralGitFileSystem = {
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
