import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AccountPackageApprovePublishRoute } from '#client/routes/account-package-approve-publish.tsx'
import { type AccountPackageApprovePublishLoaderData } from '#universal/loader-data.ts'

const approvePublishHref =
	'/account/packages/1c43570a-b9ab-46c9-86ec-6c9f02926944/approve-publish?commit=34f338c19f91c698c3a28edd2992e0ab87dcb4e0'

const loaderData: AccountPackageApprovePublishLoaderData = {
	ok: true,
	email: 'owner@example.com',
	package: {
		id: '1c43570a-b9ab-46c9-86ec-6c9f02926944',
		name: '@kodykoala/gmail-drafts',
		kodyId: 'gmail-drafts',
		sourceId: 'source-1',
		lockedAt: '2026-08-31T18:00:00.000Z',
	},
	publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	pendingCommit: '34f338c19f91c698c3a28edd2992e0ab87dcb4e0',
	alreadyPublished: false,
	filesHref: '/@kodykoala/gmail-drafts/tree/main',
	packageHref: '/@kodykoala/gmail-drafts',
	diff: {
		files: [
			{
				path: 'README.md',
				status: 'modified',
				patch:
					'--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Drafts\n+# Gmail drafts\n',
			},
		],
		omittedCount: 0,
	},
}

test('approve-publish SSR renders the promote card without a browser location', async () => {
	// Workers SSR has no `location` global. The previous setup-phase read of
	// `location.pathname` threw and streamed a blank document for the
	// documented locked-package approval_url.
	expect(typeof globalThis.location).toBe('undefined')

	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: approvePublishHref,
			children: jsx(AppLoaderDataProvider, {
				loaderData: { accountPackageApprovePublish: loaderData },
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)

	expect(html).toContain('Approve package publish')
	expect(html).toContain('data-testid="package-approve-publish-card"')
	expect(html).toContain('@kodykoala/gmail-drafts')
	expect(html).toContain('34f338c19f91c698c3a28edd2992e0ab87dcb4e0')
	expect(html).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
	expect(html).toContain('Promote this commit')
	expect(html).toContain('Browse published files')
	expect(html).toContain('data-testid="package-publish-diff"')
	expect(html).toContain('README.md')
	expect(html).toContain('# Gmail drafts')
})

test('unlocked approve-publish SSR offers Publish HEAD', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: approvePublishHref,
			children: jsx(AppLoaderDataProvider, {
				loaderData: {
					accountPackageApprovePublish: {
						...loaderData,
						package: { ...loaderData.package, lockedAt: null },
					},
				},
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)

	expect(html).toContain('Publish HEAD')
	expect(html).toContain('data-testid="approve-package-publish"')
	expect(html).not.toContain('Promote this commit')
})
