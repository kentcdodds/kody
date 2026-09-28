import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { privacyRetentionPeriods } from './privacy-retention.ts'

const privacyDocPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../docs/use/privacy.md',
)

function readDocRetentionBullets(markdown: string) {
	const section = markdown.split(/^## How long Kody keeps data$/m)[1]
	if (!section) throw new Error('privacy.md is missing its retention section')
	const body = section.split(/^## /m)[0] ?? ''
	const bullets: Array<string> = []
	for (const line of body.split('\n')) {
		if (line.startsWith('- ')) {
			bullets.push(line.slice(2).trim())
		} else if (/^\s+\S/.test(line) && bullets.length > 0) {
			bullets[bullets.length - 1] += ` ${line.trim()}`
		}
	}
	return bullets
}

test('docs/use/privacy.md retention list matches the /privacy page source', () => {
	const bullets = readDocRetentionBullets(readFileSync(privacyDocPath, 'utf8'))
	expect(bullets).toEqual([...privacyRetentionPeriods])
})
