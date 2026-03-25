import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function resolveLocalBinary(binaryName: string) {
	const localBinaryPath = path.join(
		process.cwd(),
		'node_modules',
		'.bin',
		process.platform === 'win32' ? `${binaryName}.cmd` : binaryName,
	)

	return existsSync(localBinaryPath) ? localBinaryPath : binaryName
}

export function resolveNpmCommand() {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function isExecutedDirectly(importMetaUrl: string) {
	const entryPoint = process.argv[1]
	if (!entryPoint) {
		return false
	}

	return pathToFileURL(path.resolve(entryPoint)).href === importMetaUrl
}
