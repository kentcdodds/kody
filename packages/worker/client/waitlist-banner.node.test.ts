import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { WaitlistBanner } from './waitlist-banner.tsx'

test('waitlist banner idle announcer is a status region without invalid fields', async () => {
	const html = await renderToString(jsx(WaitlistBanner, {}))
	expect(html).toContain('role="status"')
	expect(html).not.toContain('aria-invalid')
	expect(html).toContain('-waitlist-status')
	expect(html).toContain('kody-turnstile')
})

test('waitlist banner form wraps so Turnstile can drop under the pill', async () => {
	const html = await renderToString(jsx(WaitlistBanner, {}))
	const formClass = html.match(/<form class="([^"]+)"/)?.[1]?.split(/\s+/)[0]
	expect(formClass).toBeTruthy()
	const formRule = html.match(
		new RegExp(
			`\\.${formClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`,
		),
	)?.[1]
	expect(formRule).toMatch(/flex-wrap:\s*wrap/)
})
