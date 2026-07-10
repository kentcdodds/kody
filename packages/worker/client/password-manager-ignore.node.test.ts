import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { passwordManagerIgnoreProps } from './password-manager-ignore.ts'

const clientDir = path.dirname(fileURLToPath(import.meta.url))
const routesDir = path.join(clientDir, 'routes')

/** Account password sign-in / sign-up surfaces where managers should help. */
const passwordManagerAllowedFiles = new Set([
	'login.tsx',
	'oauth-authorize.tsx',
])

async function listTsxFiles(dir: string): Promise<Array<string>> {
	const entries = await readdir(dir, { withFileTypes: true })
	const files: Array<string> = []
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...(await listTsxFiles(fullPath)))
			continue
		}
		if (entry.isFile() && entry.name.endsWith('.tsx')) {
			files.push(fullPath)
		}
	}
	return files
}

test('passwordManagerIgnoreProps exports the ignore attributes password managers recognize', () => {
	expect(passwordManagerIgnoreProps.autoComplete).toBe('off')
	expect(passwordManagerIgnoreProps['data-1p-ignore']).toBe(true)
	expect(passwordManagerIgnoreProps['data-lpignore']).toBe('true')
})

test('password inputs outside sign-in/sign-up opt out of password managers', async () => {
	const files = await listTsxFiles(routesDir)
	const violations: Array<string> = []

	for (const filePath of files) {
		const relativeName = path.relative(routesDir, filePath)
		if (passwordManagerAllowedFiles.has(path.basename(filePath))) {
			continue
		}
		const source = await readFile(filePath, 'utf8')
		if (!source.includes('type="password"')) {
			continue
		}
		if (
			!source.includes('passwordManagerIgnoreProps') &&
			!source.includes('data-1p-ignore')
		) {
			violations.push(relativeName)
		}
	}

	expect(violations).toEqual([])
})
