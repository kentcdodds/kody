import { expect, test } from 'vitest'
import {
	packageSecretName,
	personalPackageFiles,
	platformPackageFiles,
} from './rehearsal-packages.ts'

function readManifest(files: Array<{ path: string; content: string }>) {
	const manifest = files.find((file) => file.path === 'package.json')
	return JSON.parse(manifest?.content ?? '{}') as {
		name: string
		exports: Record<string, string>
		kody: {
			app?: { entry: string }
			jobs?: Record<string, { entry: string }>
			webhooks?: Array<{ export: string }>
		}
	}
}

test('the personal package declares an app, two jobs, a webhook, and resolvable exports', () => {
	const files = personalPackageFiles({
		username: 'rh-alice',
		echoUrl:
			'https://kody-branch-x-mock-cloudflare.example.workers.dev/__mocks/rehearsal/echo',
		oneOffRunAt: '2026-11-08T00:00:00.000Z',
	})
	const paths = new Set(files.map((file) => file.path))
	const manifest = readManifest(files)
	expect(manifest.name).toBe('@rh-alice/rehearsal-notes')
	for (const target of Object.values(manifest.exports)) {
		expect(paths).toContain(target.replace(/^\.\//, ''))
	}
	expect(paths).toContain(manifest.kody.app?.entry.replace(/^\.\//, ''))
	expect(Object.keys(manifest.kody.jobs ?? {})).toEqual([
		'daily-digest',
		'one-off-reminder',
	])
	for (const job of Object.values(manifest.kody.jobs ?? {})) {
		expect(paths).toContain(job.entry.replace(/^\.\//, ''))
	}
	expect(manifest.exports).toHaveProperty(
		manifest.kody.webhooks?.[0]?.export ?? '',
	)
	expect(paths).toContain('README.md')
	expect(paths).toContain('AGENTS.md')
	const proof = files.find(
		(file) => file.path === 'src/secret-proof.ts',
	)?.content
	expect(proof).toContain(`{{secret:${packageSecretName}}}`)
})

test('platform packages live under the platform scope', () => {
	const manifest = readManifest(
		platformPackageFiles({
			scope: 'rh-platform',
			leaf: 'tools',
			description: 'd',
		}),
	)
	expect(manifest.name).toBe('@rh-platform/tools')
})
