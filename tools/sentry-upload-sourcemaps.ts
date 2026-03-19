import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = join(root, '.wrangler', 'sentry-bundle')

const release =
	process.env.SENTRY_RELEASE?.trim() ||
	process.env.APP_COMMIT_SHA?.trim() ||
	process.env.DEPLOY_COMMIT_SHA?.trim()
const org = process.env.SENTRY_ORG?.trim()
const project = process.env.SENTRY_PROJECT?.trim()
const authToken = process.env.SENTRY_AUTH_TOKEN?.trim()

if (!existsSync(join(bundleDir, 'index.js'))) {
	console.warn(
		'sentry-upload-sourcemaps: missing bundle at .wrangler/sentry-bundle (run deploy with --outdir .wrangler/sentry-bundle first)',
	)
	process.exit(0)
}

if (!release || !org || !project || !authToken) {
	console.log(
		'sentry-upload-sourcemaps: skipping (need SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT, and SENTRY_RELEASE or APP_COMMIT_SHA)',
	)
	process.exit(0)
}

const sentryCliWrapper = join(
	root,
	'node_modules',
	'@sentry',
	'cli',
	'bin',
	'sentry-cli',
)
const args = [
	sentryCliWrapper,
	'sourcemaps',
	'upload',
	bundleDir,
	'--release',
	release,
	'--org',
	org,
	'--project',
	project,
	'--auth-token',
	authToken,
	'--validate',
]

const result = spawnSync(process.execPath, args, {
	cwd: root,
	stdio: 'inherit',
})
process.exit(result.status === null ? 1 : result.status)
