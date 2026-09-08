import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { emptyDraft } from './routes/admin-banners-shared.ts'
import { SiteBannerEditor } from './site-banner-editor.tsx'

test('empty promo draft is an editable banner, not untitled placeholder copy', async () => {
	const html = await renderToString(
		jsx(SiteBannerEditor, {
			draft: emptyDraft(),
			onDraftChange: () => {},
		}),
	)
	expect(html).toContain('data-testid="site-banner-preview-promo"')
	expect(html).toContain('data-look="promo"')
	expect(html).toContain('aria-label="Editable banner preview"')
	expect(html).toContain('Banner title')
	expect(html).toContain('Optional body')
	expect(html).toContain('>Title<')
	expect(html).toContain('>Body<')
	expect(html).toContain('>CTA label<')
	expect(html).toContain('>CTA URL<')
	expect(html).toContain('min-height: 7.5rem')
	expect(html).not.toContain('Untitled banner')
})
