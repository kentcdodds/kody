import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const envPath = join(process.cwd(), '.env')
if (existsSync(envPath)) {
	process.exit(0)
}

const examplePath = join(process.cwd(), '.env.example')
if (!existsSync(examplePath)) {
	console.error(
		'Missing .env and .env.example; cannot prepare E2E environment.',
	)
	process.exit(1)
}

copyFileSync(examplePath, envPath)
console.log('Created .env from .env.example for E2E tests.')
