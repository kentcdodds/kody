import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { AccountPackageDeleteDialog } from './account-package-delete-dialog.tsx'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

const packageName = '@kentcdodds/tmp-parental-consent-mime-20260912'

const packageDetail: AccountPackageDetail = {
	id: 'pkg-1',
	name: packageName,
	kodyId: 'tmp-parental-consent-mime-20260912',
	description: '',
	tags: [],
	hasApp: false,
	sourceId: 'source-1',
	lockedAt: null,
	createdAt: '2026-09-12T00:00:00.000Z',
	updatedAt: '2026-09-12T00:00:00.000Z',
	hidden: false,
	isPrivate: false,
	hasCommunityListing: false,
	listingAhead: null,
	forkAhead: null,
	searchText: null,
	exports: null,
	tokens: [],
	publishedCommit: null,
}

test('package delete dialog puts a tooltip-only copy icon next to the confirm name', async () => {
	const html = await renderToString(
		jsx(AccountPackageDeleteDialog, {
			ownerUsername: 'kentcdodds',
			packageDetail,
		}),
	)

	expect(html).toContain(`data-copy-text="${packageName}"`)
	expect(html).toContain('data-copy-prompt')
	expect(html).toContain('data-testid="package-delete-copy-name"')
	expect(html).toContain('data-icon="copy"')
	expect(html).toContain('aria-label="Copy package name"')
	expect(html).toMatch(/role="tooltip"[^>]*>Copy</)
	expect(html).not.toContain('data-swap-label')
	expect(html).toContain(`placeholder="${packageName}"`)
	expect(html).toContain(`Type <strong>${packageName}</strong> to`)

	const titleAt = html.indexOf('id="delete-package-title"')
	const copyAt = html.indexOf('data-testid="package-delete-copy-name"')
	const confirmAt = html.indexOf('data-testid="package-delete-confirmation"')
	expect(titleAt).toBeGreaterThan(-1)
	expect(copyAt).toBeGreaterThan(titleAt)
	expect(confirmAt).toBeGreaterThan(copyAt)
})
