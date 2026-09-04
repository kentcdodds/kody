import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// Origin production maps come from `vite build` (`dist/ssr`). The Wrangler
// `--outdir .wrangler/sentry-bundle` paths stay as fallbacks for sibling
// scripts and older deploy logs.
const workerBundleCandidates = [
	join(root, 'dist', 'ssr'),
	join(root, 'packages', 'worker', '.wrangler', 'sentry-bundle'),
	join(root, '.wrangler', 'sentry-bundle'),
]
const clientAssetsDir = join(root, 'dist', 'client')

const release =
	process.env.SENTRY_RELEASE?.trim() ||
	process.env.APP_COMMIT_SHA?.trim() ||
	process.env.DEPLOY_COMMIT_SHA?.trim()
const org = process.env.SENTRY_ORG?.trim()
const project = process.env.SENTRY_PROJECT?.trim()
const authToken = process.env.SENTRY_AUTH_TOKEN?.trim()

if (!release || !org || !project || !authToken) {
	console.log(
		'sentry-upload-sourcemaps: skipping (need SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, and SENTRY_RELEASE or APP_COMMIT_SHA)',
	)
	process.exit(0)
}

function hasSourceMaps(dir: string): boolean {
	if (!existsSync(dir)) return false
	try {
		return readdirSync(dir, { recursive: true }).some((entry) =>
			String(entry).endsWith('.js.map'),
		)
	} catch {
		return false
	}
}

const sentryCliWrapper = join(
	root,
	'node_modules',
	'@sentry',
	'cli',
	'bin',
	'sentry-cli',
)

function upload(dir: string, label: string): void {
	console.log(`sentry-upload-sourcemaps: uploading ${label} from ${dir}`)
	// Auth comes from the inherited SENTRY_AUTH_TOKEN env var (already
	// validated above) rather than --auth-token, so the secret never appears
	// in child process arguments.
	const result = spawnSync(
		process.execPath,
		[
			sentryCliWrapper,
			'sourcemaps',
			'upload',
			dir,
			'--release',
			release!,
			'--org',
			org!,
			'--project',
			project!,
			'--validate',
		],
		{ cwd: root, stdio: 'inherit' },
	)
	if (result.status !== 0) {
		throw new Error(
			`sentry-upload-sourcemaps: ${label} upload failed with status ${result.status}`,
		)
	}
}

const workerBundleDir = workerBundleCandidates.find((dir) => hasSourceMaps(dir))
// Credentials are configured, so a missing bundle is a broken pipeline, not
// an optional feature — fail the deploy step loudly instead of silently
// shipping a release whose stack traces cannot be symbolicated. (This exact
// silent no-op hid a path mismatch for weeks.)
if (!workerBundleDir) {
	console.error(
		`sentry-upload-sourcemaps: no worker bundle with source maps found (checked: ${workerBundleCandidates.join(', ')}). Origin maps come from \`vite build\` (\`dist/ssr\`); sibling deploys still use \`--outdir .wrangler/sentry-bundle --upload-source-maps\`.`,
	)
	process.exit(1)
}
upload(workerBundleDir, 'worker bundle')

// Client assets are built with --sourcemap and debug-id injected before
// deploy; upload them under the same release so browser events symbolicate.
if (hasSourceMaps(clientAssetsDir)) {
	upload(clientAssetsDir, 'client assets')
} else {
	console.error(
		'sentry-upload-sourcemaps: no client source maps in dist/client (expected from vite build).',
	)
	process.exit(1)
}
