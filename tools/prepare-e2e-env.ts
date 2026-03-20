import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const envPath = join(process.cwd(), '.env')
const examplePath = join(process.cwd(), '.env.example')

function parseDotenvValue(content: string, key: string) {
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue
		const withoutExport = line.startsWith('export ') ? line.slice(7) : line
		if (!withoutExport.startsWith(`${key}=`)) continue
		return withoutExport.slice(key.length + 1).trim()
	}
	return null
}

if (!existsSync(examplePath)) {
	console.error(
		'Missing .env and .env.example; cannot prepare E2E environment.',
	)
	process.exit(1)
}

if (!existsSync(envPath)) {
	copyFileSync(examplePath, envPath)
	console.log('Created .env from .env.example for E2E tests.')
	process.exit(0)
}

const envContents = readFileSync(envPath, 'utf8')
const existingCookieSecret = parseDotenvValue(envContents, 'COOKIE_SECRET')
if (existingCookieSecret && existingCookieSecret.length > 0) {
	process.exit(0)
}

const exampleContents = readFileSync(examplePath, 'utf8')
const fallbackCookieSecret = parseDotenvValue(exampleContents, 'COOKIE_SECRET')
if (!fallbackCookieSecret || fallbackCookieSecret.length === 0) {
	console.error(
		'Missing COOKIE_SECRET in .env.example; cannot prepare E2E env.',
	)
	process.exit(1)
}

const nextContents = envContents.endsWith('\n')
	? `${envContents}COOKIE_SECRET=${fallbackCookieSecret}\n`
	: `${envContents}\nCOOKIE_SECRET=${fallbackCookieSecret}\n`
writeFileSync(envPath, nextContents, 'utf8')
console.log('Backfilled COOKIE_SECRET in .env for E2E tests.')
