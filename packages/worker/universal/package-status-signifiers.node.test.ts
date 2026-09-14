import { expect, test } from 'vitest'
import { renderToString } from 'remix/ui/server'
import {
	listPackageStatusSignifiers,
	renderPackageStatusSignifiers,
} from './package-status-signifiers.tsx'

test('private packages get a lock tooltip and never a not-published mark', () => {
	expect(
		listPackageStatusSignifiers({ isPrivate: true, isListed: false }),
	).toEqual([{ kind: 'private', name: 'lock', title: 'Private' }])
	expect(
		listPackageStatusSignifiers({ isPrivate: true, isListed: true }),
	).toEqual([{ kind: 'private', name: 'lock', title: 'Private' }])
})

test('unlisted public packages get a not-published mark; listed public packages get none', () => {
	expect(
		listPackageStatusSignifiers({ isPrivate: false, isListed: false }),
	).toEqual([{ kind: 'unpublished', name: 'file', title: 'Not published' }])
	expect(
		listPackageStatusSignifiers({ isPrivate: false, isListed: true }),
	).toEqual([])
})

test('rendered signifiers are icon tooltips, not text pills', async () => {
	const privateHtml = await renderToString(
		renderPackageStatusSignifiers({ isPrivate: true, isListed: false }),
	)
	expect(privateHtml).toContain('data-testid="package-visibility-badge"')
	expect(privateHtml).toContain('data-visibility="private"')
	expect(privateHtml).toContain('data-signifier="private"')
	expect(privateHtml).toContain('data-icon="lock"')
	expect(privateHtml).toContain('title="Private"')
	expect(privateHtml).not.toContain('data-signifier="unpublished"')
	expect(privateHtml).not.toMatch(/>Private</)
	expect(privateHtml).not.toMatch(/>Not published</)

	const unpublishedHtml = await renderToString(
		renderPackageStatusSignifiers({ isPrivate: false, isListed: false }),
	)
	expect(unpublishedHtml).toContain('data-signifier="unpublished"')
	expect(unpublishedHtml).toContain('data-icon="file"')
	expect(unpublishedHtml).toContain('title="Not published"')
	expect(unpublishedHtml).not.toContain('data-signifier="private"')
	expect(unpublishedHtml).not.toMatch(/>Not published</)
})
