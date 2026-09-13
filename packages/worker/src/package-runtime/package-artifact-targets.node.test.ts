import { expect, test } from 'vitest'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { collectPublishedPackageArtifactTargets } from './package-artifact-targets.ts'

function parseManifest(app: Record<string, string> | undefined) {
	return parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kentcdodds/demo-app',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'demo-app',
				description: 'Demo app',
				app,
			},
		}),
	})
}

test('kody.app.client adds an app-client target next to the Worker app target', () => {
	const targets = collectPublishedPackageArtifactTargets(
		parseManifest({
			entry: './src/app.ts',
			client: './src/client.tsx',
			assets: './public',
		}),
	)

	expect(targets).toEqual([
		{ kind: 'app', entryPoint: 'src/app.ts', bundleKind: 'app' },
		{
			kind: 'app-client',
			entryPoint: 'src/client.tsx',
			bundleKind: 'app-client',
		},
		{
			kind: 'module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'module',
		},
		{
			kind: 'importable-module',
			artifactName: '.',
			entryPoint: 'src/index.ts',
			bundleKind: 'importable-module',
		},
	])
})

test('apps without kody.app.client keep the Worker-only target set', () => {
	const targets = collectPublishedPackageArtifactTargets(
		parseManifest({ entry: './src/app.ts' }),
	)
	expect(targets.map((target) => target.kind)).toEqual([
		'app',
		'module',
		'importable-module',
	])
	expect(
		collectPublishedPackageArtifactTargets(parseManifest(undefined)).map(
			(target) => target.kind,
		),
	).toEqual(['module', 'importable-module'])
})

test('kody.app.assets alone adds no artifact target because static files are served from the source snapshot', () => {
	const targets = collectPublishedPackageArtifactTargets(
		parseManifest({ entry: './src/app.ts', assets: './public' }),
	)
	expect(targets.map((target) => target.kind)).toEqual([
		'app',
		'module',
		'importable-module',
	])
})
