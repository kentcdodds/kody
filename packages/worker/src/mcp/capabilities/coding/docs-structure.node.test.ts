import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { expect, test } from 'vitest'

const repoRoot = path.resolve(
	fileURLToPath(new URL('.', import.meta.url)),
	'../../../../../..',
)

function docPath(...segments: string[]): string {
	return path.join(repoRoot, 'docs', ...segments)
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch {
		return false
	}
}

async function readDoc(...segments: string[]): Promise<string> {
	return readFile(docPath(...segments), 'utf8')
}

test('new documentation files introduced in this PR exist', async () => {
	await expect(
		access(docPath('contributing', 'packages-and-manifests.md')),
		'docs/contributing/packages-and-manifests.md must exist',
	).resolves.toBeUndefined()

	await expect(
		access(docPath('use', 'packages.md')),
		'docs/use/packages.md must exist',
	).resolves.toBeUndefined()
})

test('documentation files deleted in this PR no longer exist', async () => {
	const deletedFiles = [
		docPath('contributing', 'mcp-skills.md'),
		docPath('contributing', 'mcp-apps-spec-notes.md'),
		docPath('contributing', 'skill-patterns', 'index.md'),
		docPath('use', 'saved-app-backends.md'),
		docPath('use', 'examples', 'saved-app-counter.md'),
	]
	for (const filePath of deletedFiles) {
		const exists = await fileExists(filePath)
		expect(
			exists,
			`deleted file must not exist: ${path.relative(repoRoot, filePath)}`,
		).toBe(false)
	}
})

test('contributing/index.md references packages-and-manifests.md', async () => {
	const content = await readDoc('contributing', 'index.md')
	expect(content).toContain('packages-and-manifests.md')
})

test('contributing/index.md does not reference deleted mcp-skills.md', async () => {
	const content = await readDoc('contributing', 'index.md')
	expect(content).not.toContain('mcp-skills.md')
	expect(content).not.toContain('mcp-apps-spec-notes.md')
})

test('use/index.md references the new packages.md', async () => {
	const content = await readDoc('use', 'index.md')
	expect(content).toContain('packages.md')
})

test('use/index.md does not reference deleted files', async () => {
	const content = await readDoc('use', 'index.md')
	expect(content).not.toContain('saved-app-backends.md')
	expect(content).not.toContain('skills-and-apps.md')
})

test('contributing/adding-capabilities.md references packages-and-manifests.md not mcp-skills.md', async () => {
	const content = await readDoc('contributing', 'adding-capabilities.md')
	expect(content).toContain('packages-and-manifests.md')
	expect(content).not.toContain('mcp-skills.md')
})

test('guides/README.md references all expected guide files', async () => {
	const content = await readDoc('guides', 'README.md')
	const expectedGuideFiles = [
		'integration-bootstrap.md',
		'integration-backed-app-happy-path.md',
		'oauth.md',
		'generated-ui-oauth.md',
		'connect-secret.md',
	]
	for (const file of expectedGuideFiles) {
		expect(content, `guides/README.md must reference ${file}`).toContain(file)
	}
})

test('all guide files listed in guides/README.md exist on disk', async () => {
	const content = await readDoc('guides', 'README.md')
	const mdLinkPattern = /\[.*?\]\((\.\/[\w-]+\.md)\)/g
	const matches = [...content.matchAll(mdLinkPattern)]
	expect(matches.length).toBeGreaterThan(0)
	for (const match of matches) {
		const relativePath = match[1].replace('./', '')
		const filePath = docPath('guides', relativePath)
		const exists = await fileExists(filePath)
		expect(
			exists,
			`guide file referenced in README.md does not exist: ${relativePath}`,
		).toBe(true)
	}
})

test('packages-and-manifests.md has the required sections', async () => {
	const content = await readDoc('contributing', 'packages-and-manifests.md')
	const requiredSections = [
		'## Source of truth',
		'## Mental model',
		'## Package exports',
		'## Package apps',
		'## Package-owned jobs',
		'## Repo-backed workflow',
		'## Search and discovery',
	]
	for (const section of requiredSections) {
		expect(
			content,
			`packages-and-manifests.md must contain section: ${section}`,
		).toContain(section)
	}
})

test('use/packages.md has the required sections', async () => {
	const content = await readDoc('use', 'packages.md')
	const requiredSections = [
		'## Mental model',
		'## Package exports',
		'## Package apps',
		'## Package-owned jobs',
		'## Save and edit packages',
		'## Search and discovery',
	]
	for (const section of requiredSections) {
		expect(
			content,
			`use/packages.md must contain section: ${section}`,
		).toContain(section)
	}
})

test('packages-and-manifests.md documents the package.json#kody fields', async () => {
	const content = await readDoc('contributing', 'packages-and-manifests.md')
	const requiredFields = [
		'kody.id',
		'kody.description',
		'kody.tags',
		'kody.app',
		'kody.jobs',
	]
	for (const field of requiredFields) {
		expect(
			content,
			`packages-and-manifests.md must document field: ${field}`,
		).toContain(field)
	}
})

test('use/packages.md documents the package.json#kody fields', async () => {
	const content = await readDoc('use', 'packages.md')
	const requiredFields = [
		'kody.id',
		'kody.description',
		'kody.tags',
		'kody.app',
		'kody.jobs',
	]
	for (const field of requiredFields) {
		expect(
			content,
			`use/packages.md must document field: ${field}`,
		).toContain(field)
	}
})

test('use/repo-sessions.md references package identity not skill identity', async () => {
	const content = await readDoc('use', 'repo-sessions.md')
	expect(content).toContain('"kind": "package"')
	expect(content).not.toContain('"kind": "skill"')
	expect(content).not.toContain('"kind": "app"')
})

test('contributing/architecture/data-storage.md uses package terminology', async () => {
	const content = await readDoc(
		'contributing',
		'architecture',
		'data-storage.md',
	)
	expect(content).toContain('Repo-backed packages')
	expect(content).not.toContain('Repo-backed sources and Artifacts')
})

test('docs/use/execute.md references kody:runtime import pattern', async () => {
	const content = await readDoc('use', 'execute.md')
	expect(content).toContain('kody:runtime')
	expect(content).toContain('Saved packages')
})

test('docs/use/first-steps.md references package model', async () => {
	const content = await readDoc('use', 'first-steps.md')
	expect(content).toContain('Think in packages')
})

test('contributing/end-to-end-testing.md uses package-app terminology', async () => {
	const content = await readDoc('contributing', 'end-to-end-testing.md')
	expect(content).toContain('package-app')
	expect(content).not.toContain('saved-app session')
})

test('contributing/testing-principles.md uses package-app terminology', async () => {
	const content = await readDoc('contributing', 'testing-principles.md')
	expect(content).toContain('package-app')
	expect(content).not.toContain('saved-app session')
})

test('docs/guides/integration-bootstrap.md uses package terminology', async () => {
	const content = await readDoc('guides', 'integration-bootstrap.md')
	expect(content).toContain('package')
	expect(content).not.toContain('auth-dependent skill or app as complete')
})

test('docs/guides/oauth.md references package-first recommendation', async () => {
	const content = await readDoc('guides', 'oauth.md')
	expect(content).toContain('Package-first recommendation after OAuth')
})

test('skill-patterns directory contains only the expected remaining files', async () => {
	const cloudflareApiFile = docPath(
		'contributing',
		'skill-patterns',
		'cloudflare-api-v4.md',
	)
	const cloudflareDocsFile = docPath(
		'contributing',
		'skill-patterns',
		'cloudflare-developer-docs.md',
	)
	const indexFile = docPath('contributing', 'skill-patterns', 'index.md')

	await expect(
		access(cloudflareApiFile),
		'cloudflare-api-v4.md must still exist',
	).resolves.toBeUndefined()
	await expect(
		access(cloudflareDocsFile),
		'cloudflare-developer-docs.md must still exist',
	).resolves.toBeUndefined()
	const indexExists = await fileExists(indexFile)
	expect(
		indexExists,
		'skill-patterns/index.md was deleted and must not exist',
	).toBe(false)
})

test('skill-patterns/cloudflare-api-v4.md uses updated module body heading', async () => {
	const content = await readDoc(
		'contributing',
		'skill-patterns',
		'cloudflare-api-v4.md',
	)
	expect(content).toContain('## Example module body')
	expect(content).not.toContain('## Example skill')
})

test('skill-patterns/cloudflare-developer-docs.md uses updated heading and terminology', async () => {
	const content = await readDoc(
		'contributing',
		'skill-patterns',
		'cloudflare-developer-docs.md',
	)
	expect(content).toContain('## Example module body')
	expect(content).not.toContain('meta_save_skill')
})