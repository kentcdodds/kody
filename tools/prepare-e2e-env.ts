import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const workerDir = join(process.cwd(), 'packages', 'worker')
const envPath = join(workerDir, '.env')
const examplePath = join(workerDir, '.env.example')

function escapeForRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripSurroundingQuotes(value: string) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1)
	}
	return value
}

function parseDotenvValue(content: string, key: string) {
	const keyPattern = new RegExp(
		`^\\s*(?:export\\s+)?${escapeForRegExp(key)}\\s*=\\s*(.*)$`,
	)
	let matchedValue: string | null = null

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith('#')) continue

		const match = rawLine.match(keyPattern)
		if (!match) continue

		matchedValue = stripSurroundingQuotes(match[1]?.trim() ?? '')
	}

	return matchedValue
}

function setDotenvValue(content: string, key: string, value: string) {
	const lines = content.split(/\r?\n/)
	const keyPattern = new RegExp(
		`^(\\s*(?:export\\s+)?${escapeForRegExp(key)}\\s*=\\s*).*$`,
	)

	let lastMatchIndex = -1
	let lastPrefix = `${key}=`
	for (const [index, line] of lines.entries()) {
		const match = line.match(keyPattern)
		if (!match) continue
		lastMatchIndex = index
		lastPrefix = match[1] ?? lastPrefix
	}

	if (lastMatchIndex >= 0) {
		lines[lastMatchIndex] = `${lastPrefix}${value}`
		return `${lines.join('\n').replace(/\n*$/, '\n')}`
	}

	return `${content.replace(/\n*$/, '\n')}${key}=${value}\n`
}

if (!existsSync(envPath)) {
	if (!existsSync(examplePath)) {
		console.error('Missing packages/worker/.env.example; cannot prepare E2E environment.')
		process.exit(1)
	}
	copyFileSync(examplePath, envPath)
	console.log(
		'Created packages/worker/.env from packages/worker/.env.example for E2E tests.',
	)
}

const envContents = readFileSync(envPath, 'utf8')
const existingCookieSecret = parseDotenvValue(envContents, 'COOKIE_SECRET')
if (existingCookieSecret && existingCookieSecret.length > 0) {
	process.exit(0)
}

if (!existsSync(examplePath)) {
	console.error('Missing packages/worker/.env.example; cannot prepare E2E environment.')
	process.exit(1)
}

const exampleContents = readFileSync(examplePath, 'utf8')
const fallbackCookieSecret = parseDotenvValue(exampleContents, 'COOKIE_SECRET')
if (!fallbackCookieSecret || fallbackCookieSecret.length === 0) {
	console.error(
		'Missing COOKIE_SECRET in packages/worker/.env.example; cannot prepare E2E env.',
	)
	process.exit(1)
}

const nextContents = setDotenvValue(
	envContents,
	'COOKIE_SECRET',
	fallbackCookieSecret,
)
writeFileSync(envPath, nextContents, 'utf8')
console.log('Backfilled COOKIE_SECRET in packages/worker/.env for E2E tests.')
