import { createIsomorphicGitFs } from './isomorphic-git-fs.ts'

type EphemeralGitFileSystem = Parameters<typeof createIsomorphicGitFs>[0]

/**
 * Collapse `.` / `..` segments and empty parts so isomorphic-git walker paths
 * like `/repo/.` resolve to the same store key as `/repo`.
 */
function normalizeFsPath(path: string): string {
	const parts: Array<string> = []
	for (const part of path.split('/')) {
		if (!part || part === '.') continue
		if (part === '..') {
			parts.pop()
			continue
		}
		parts.push(part)
	}
	return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

export function createEphemeralGitWorkspace() {
	const store = new Map<string, Uint8Array>()
	const symlinkTargets = new Map<string, string>()
	const textDecoder = new TextDecoder()
	const textEncoder = new TextEncoder()
	function resolveSymlinkPath(path: string, target: string) {
		const parts = target.startsWith('/')
			? []
			: path.split('/').slice(0, -1).filter(Boolean)
		for (const part of target.split('/')) {
			if (!part || part === '.') continue
			if (part === '..') {
				parts.pop()
			} else {
				parts.push(part)
			}
		}
		return `/${parts.join('/')}`
	}
	function readStoredBytes(path: string, depth = 0): Uint8Array {
		const normalized = normalizeFsPath(path)
		if (depth > 16) {
			throw Object.assign(new Error(`ELOOP: ${normalized}`), { code: 'ELOOP' })
		}
		const target = symlinkTargets.get(normalized)
		if (target != null) {
			return readStoredBytes(resolveSymlinkPath(normalized, target), depth + 1)
		}
		const bytes = store.get(normalized)
		if (!bytes) {
			throw Object.assign(new Error(`ENOENT: ${normalized}`), {
				code: 'ENOENT',
			})
		}
		return bytes
	}
	function storedStat(path: string, followSymlink: boolean) {
		const normalized = normalizeFsPath(path)
		if (normalized === '/') {
			return {
				type: 'directory' as const,
				size: 0,
				mtime: new Date(),
			}
		}
		const target = symlinkTargets.get(normalized)
		if (target != null && !followSymlink) {
			return {
				type: 'symlink' as const,
				size: textEncoder.encode(target).byteLength,
				mtime: new Date(),
			}
		}
		if (target != null) {
			return storedStat(resolveSymlinkPath(normalized, target), true)
		}
		if (!store.has(normalized)) {
			throw Object.assign(new Error(`ENOENT: ${normalized}`), {
				code: 'ENOENT',
			})
		}
		const isDirectory = [...store.keys()].some(
			(key) => key.startsWith(`${normalized}/`) && key !== normalized,
		)
		return {
			type: isDirectory ? ('directory' as const) : ('file' as const),
			size: store.get(normalized)?.byteLength ?? 0,
			mtime: new Date(),
		}
	}
	const filesystem: EphemeralGitFileSystem = {
		readFile: async (path) => textDecoder.decode(readStoredBytes(path)),
		readFileBytes: async (path) => readStoredBytes(path),
		writeFile: async (path, data) => {
			const normalized = normalizeFsPath(path)
			symlinkTargets.delete(normalized)
			store.set(normalized, textEncoder.encode(data))
		},
		writeFileBytes: async (path, data) => {
			const normalized = normalizeFsPath(path)
			symlinkTargets.delete(normalized)
			store.set(normalized, data)
		},
		rm: async (path, options) => {
			const normalized = normalizeFsPath(path)
			if (options?.recursive) {
				for (const key of [...store.keys()]) {
					if (key === normalized || key.startsWith(`${normalized}/`)) {
						store.delete(key)
						symlinkTargets.delete(key)
					}
				}
				return
			}
			store.delete(normalized)
			symlinkTargets.delete(normalized)
		},
		mkdir: async (path, options) => {
			const normalized = normalizeFsPath(path)
			if (normalized === '/') return
			if (options?.recursive) {
				const parts = normalized.split('/').filter(Boolean)
				let current = ''
				for (const part of parts) {
					current = `${current}/${part}`
					symlinkTargets.delete(current)
					store.set(current, new Uint8Array())
				}
				return
			}
			symlinkTargets.delete(normalized)
			store.set(normalized, new Uint8Array())
		},
		readdir: async (path) => {
			const normalized = normalizeFsPath(path)
			const prefix = normalized === '/' ? '/' : `${normalized}/`
			const names = new Set<string>()
			for (const key of store.keys()) {
				if (!key.startsWith(prefix)) continue
				const rest = key.slice(prefix.length)
				const [name] = rest.split('/')
				if (name) names.add(name)
			}
			return [...names]
		},
		stat: async (path) => storedStat(path, true),
		lstat: async (path) => storedStat(path, false),
		readlink: async (path) => {
			const normalized = normalizeFsPath(path)
			const target = symlinkTargets.get(normalized)
			if (target == null) {
				throw Object.assign(new Error(`EINVAL: ${normalized}`), {
					code: 'EINVAL',
				})
			}
			return target
		},
		symlink: async (target, path) => {
			const normalized = normalizeFsPath(path)
			store.set(normalized, textEncoder.encode(target))
			symlinkTargets.set(normalized, target)
		},
	}
	return {
		fs: createIsomorphicGitFs(filesystem),
		dir: '/repo',
	}
}
