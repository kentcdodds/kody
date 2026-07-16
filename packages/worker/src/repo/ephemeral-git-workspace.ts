import { createIsomorphicGitFs } from './isomorphic-git-fs.ts'

type EphemeralGitFileSystem = Parameters<typeof createIsomorphicGitFs>[0]

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
		if (depth > 16) {
			throw Object.assign(new Error(`ELOOP: ${path}`), { code: 'ELOOP' })
		}
		const target = symlinkTargets.get(path)
		if (target != null) {
			return readStoredBytes(resolveSymlinkPath(path, target), depth + 1)
		}
		const bytes = store.get(path)
		if (!bytes) {
			throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
		}
		return bytes
	}
	function storedStat(path: string, followSymlink: boolean) {
		const target = symlinkTargets.get(path)
		if (target != null && !followSymlink) {
			return {
				type: 'symlink' as const,
				size: textEncoder.encode(target).byteLength,
				mtime: new Date(),
			}
		}
		if (target != null) {
			return storedStat(resolveSymlinkPath(path, target), true)
		}
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
	}
	const filesystem: EphemeralGitFileSystem = {
		readFile: async (path) => textDecoder.decode(readStoredBytes(path)),
		readFileBytes: async (path) => readStoredBytes(path),
		writeFile: async (path, data) => {
			symlinkTargets.delete(path)
			store.set(path, textEncoder.encode(data))
		},
		writeFileBytes: async (path, data) => {
			symlinkTargets.delete(path)
			store.set(path, data)
		},
		rm: async (path, options) => {
			if (options?.recursive) {
				for (const key of [...store.keys()]) {
					if (key === path || key.startsWith(`${path}/`)) {
						store.delete(key)
						symlinkTargets.delete(key)
					}
				}
				return
			}
			store.delete(path)
			symlinkTargets.delete(path)
		},
		mkdir: async (path, options) => {
			if (options?.recursive) {
				const parts = path.split('/').filter(Boolean)
				let current = ''
				for (const part of parts) {
					current = `${current}/${part}`
					symlinkTargets.delete(current)
					store.set(current, new Uint8Array())
				}
				return
			}
			symlinkTargets.delete(path)
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
		stat: async (path) => storedStat(path, true),
		lstat: async (path) => storedStat(path, false),
		readlink: async (path) => {
			const target = symlinkTargets.get(path)
			if (target == null) {
				throw Object.assign(new Error(`EINVAL: ${path}`), { code: 'EINVAL' })
			}
			return target
		},
		symlink: async (target, path) => {
			store.set(path, textEncoder.encode(target))
			symlinkTargets.set(path, target)
		},
	}
	return {
		fs: createIsomorphicGitFs(filesystem),
		dir: '/repo',
	}
}
