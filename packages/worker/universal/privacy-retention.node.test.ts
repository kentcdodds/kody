import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	privacyRetentionPeriods,
	privacySubprocessors,
} from './privacy-retention.ts'

const privacyDocPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../docs/use/privacy.md',
)

function readDocSectionBullets(markdown: string, heading: string) {
	const section = markdown.split(new RegExp(`^## ${heading}$`, 'm'))[1]
	if (!section) throw new Error(`privacy.md is missing its ${heading} section`)
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
	const bullets = readDocSectionBullets(
		readFileSync(privacyDocPath, 'utf8'),
		'How long Kody keeps data',
	)
	expect(bullets).toEqual([...privacyRetentionPeriods])
})

test('docs/use/privacy.md subprocessors match the /privacy page source', () => {
	const bullets = readDocSectionBullets(
		readFileSync(privacyDocPath, 'utf8'),
		'Service providers',
	)
	expect(bullets).toEqual([...privacySubprocessors])
})
