import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	buildKodyOfficialGuideUrlForTest,
	kodyOfficialGuideCapability,
	kodyOfficialGuideCatalog,
	KODY_GUIDES_REPO,
	type KodyOfficialGuideId,
} from './kody-official-guide.ts'

const repoRoot = path.resolve(
	fileURLToPath(new URL('.', import.meta.url)),
	'../../../../../..',
)

const ctx = {
	env: {} as Env,
	callerContext: {
		baseUrl: 'https://kody.example',
		user: null,
	},
}

test('kody_official_guide returns markdown when fetch succeeds', async () => {
	const originalFetch = globalThis.fetch
	const url = buildKodyOfficialGuideUrlForTest('integration_bootstrap')
	expect(url).toMatch(/\/integration-bootstrap\.md$/)
	globalThis.fetch = (async (input) => {
		expect(String(input)).toBe(url)
		return new Response('# Hello\n\nbody', { status: 200 })
	}) as typeof fetch
	try {
		const result = await kodyOfficialGuideCapability.handler(
			{ guide: 'integration_bootstrap' },
			ctx,
		)
		expect(result.title).toBeTruthy()
		expect(result.body).toBe('# Hello\n\nbody')
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('kody_official_guide surfaces fetch failures', async () => {
	const originalFetch = globalThis.fetch
	try {
		await expect(
			(async () => {
				globalThis.fetch = (async () => {
					return new Response('missing', { status: 404 })
				}) as typeof fetch
				await kodyOfficialGuideCapability.handler(
					{ guide: 'connect_secret' },
					ctx,
				)
			})(),
		).rejects.toThrow(/Kody guide fetch failed: HTTP 404/)
		await expect(
			(async () => {
				globalThis.fetch = (async () => {
					throw new Error('network down')
				}) as typeof fetch
				await kodyOfficialGuideCapability.handler(
					{ guide: 'generated_ui_oauth' },
					ctx,
				)
			})(),
		).rejects.toThrow(/Kody guide fetch failed: network down/)
	} finally {
		globalThis.fetch = originalFetch
	}
})

test('kodyOfficialGuideCatalog contains exactly the expected guide IDs', () => {
	const guideIds = Object.keys(kodyOfficialGuideCatalog).sort()
	expect(guideIds).toEqual(
		[
			'integration_bootstrap',
			'integration_backed_app',
			'oauth',
			'generated_ui_oauth',
			'connect_secret',
		].sort(),
	)
})

test('each catalog entry maps to a file that exists in docs/guides/', async () => {
	const guideIds = Object.keys(
		kodyOfficialGuideCatalog,
	) as KodyOfficialGuideId[]
	for (const id of guideIds) {
		const entry = kodyOfficialGuideCatalog[id]
		const filePath = path.join(
			repoRoot,
			KODY_GUIDES_REPO.basePath,
			entry.file,
		)
		await expect(
			access(filePath),
			`catalog entry ${id} maps to missing file: ${entry.file}`,
		).resolves.toBeUndefined()
	}
})

test('buildKodyOfficialGuideUrlForTest produces raw.githubusercontent.com URLs for all entries', () => {
	const guideIds = Object.keys(
		kodyOfficialGuideCatalog,
	) as KodyOfficialGuideId[]
	for (const id of guideIds) {
		const url = buildKodyOfficialGuideUrlForTest(id)
		expect(url, `URL for guide ${id}`).toMatch(
			/^https:\/\/raw\.githubusercontent\.com\//,
		)
		expect(url, `URL for guide ${id} should end with .md`).toMatch(/\.md$/)
	}
})

test('catalog does not reference old deleted guide filenames', () => {
	const deletedFileNames = ['mcp-skills.md', 'mcp-apps-spec-notes.md']
	const allFiles = Object.values(kodyOfficialGuideCatalog).map((e) => e.file)
	for (const deleted of deletedFileNames) {
		expect(
			allFiles,
			`catalog must not reference deleted file: ${deleted}`,
		).not.toContain(deleted)
	}
})

test('each catalog entry has a non-empty title and summary', () => {
	const guideIds = Object.keys(
		kodyOfficialGuideCatalog,
	) as KodyOfficialGuideId[]
	for (const id of guideIds) {
		const entry = kodyOfficialGuideCatalog[id]
		expect(
			entry.title,
			`guide ${id} must have a non-empty title`,
		).toBeTruthy()
		expect(
			entry.summary,
			`guide ${id} must have a non-empty summary`,
		).toBeTruthy()
	}
})