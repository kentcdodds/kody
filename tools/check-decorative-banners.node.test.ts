import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
	checkDecorativeBanners,
	findDecorativeBannerMatches,
} from './check-decorative-banners.ts'

test('findDecorativeBannerMatches flags equals and dash banners only', () => {
	const content = [
		'{/* ============ hero ============ */}',
		'/* ---------- styles ---------- */',
		'/* Event glyphs are inlined rather than sprited. */',
		'/* The shirt-pattern whisper anchors to the article. */',
		'const css = {}',
	].join('\n')

	expect(
		findDecorativeBannerMatches({
			relativePath: 'packages/worker/client/routes/home.tsx',
			content,
		}),
	).toEqual([
		expect.objectContaining({
			line: 1,
			excerpt: '{/* ============ hero ============ */}',
		}),
		expect.objectContaining({
			line: 2,
			excerpt: '/* ---------- styles ---------- */',
		}),
	])
})

test('checkDecorativeBanners scans client and style-primitive trees', async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), 'decorative-banners-'))
	try {
		const clientDir = path.join(cwd, 'packages', 'worker', 'client', 'routes')
		const stylesDir = path.join(
			cwd,
			'packages',
			'worker',
			'universal',
			'styles',
		)
		await Promise.all([
			mkdir(clientDir, { recursive: true }),
			mkdir(stylesDir, { recursive: true }),
		])
		await Promise.all([
			writeFile(
				path.join(clientDir, 'home.tsx'),
				'{/* ============ hero ============ */}\nexport {}\n',
			),
			writeFile(
				path.join(stylesDir, 'style-primitives.ts'),
				'/* ---------- redesigned form fields ---------- */\nexport {}\n',
			),
			writeFile(
				path.join(clientDir, 'clean.tsx'),
				'/* Shirt-pattern comment without a banner. */\nexport {}\n',
			),
		])

		expect(await checkDecorativeBanners(cwd)).toEqual([
			expect.objectContaining({
				file: 'packages/worker/client/routes/home.tsx',
				line: 1,
			}),
			expect.objectContaining({
				file: 'packages/worker/universal/styles/style-primitives.ts',
				line: 1,
			}),
		])
	} finally {
		await rm(cwd, { recursive: true, force: true })
	}
})
