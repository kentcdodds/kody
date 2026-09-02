import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { WaitlistBanner } from './waitlist-banner.tsx'

test('waitlist banner idle announcer is a status region without invalid fields', async () => {
	const html = await renderToString(jsx(WaitlistBanner, {}))
	expect(html).toContain('role="status"')
	expect(html).not.toContain('aria-invalid')
	expect(html).toContain('-waitlist-status')
})
