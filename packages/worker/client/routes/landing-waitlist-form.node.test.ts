import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { WaitlistForm } from './landing-waitlist-form.tsx'

test('landing waitlist idle announcer is a status region without invalid fields', async () => {
	const html = await renderToString(jsx(WaitlistForm, {}))
	expect(html).toContain('role="status"')
	expect(html).not.toContain('aria-invalid')
	expect(html).toContain('-waitlist-status')
	expect(html).toContain('kody-turnstile')
})
