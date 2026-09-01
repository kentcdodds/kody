import { expect, test } from 'vitest'
import { type WaitingItem } from '#universal/waiting.ts'
import {
	formatSearchWaitingMarkdown,
	selectSearchWaitingItems,
	toSearchWaitingStructured,
} from './search-waiting.ts'

function item(
	overrides: Partial<WaitingItem> & Pick<WaitingItem, 'id' | 'kind' | 'title'>,
): WaitingItem {
	return {
		why: 'Needs a click.',
		who: 'you',
		doLabel: 'Reconnect',
		href: '/account/waiting',
		severity: 'block',
		...overrides,
	}
}

test('search waiting markdown omits setup and caps then points at waitingSummary', () => {
	const items = [
		item({
			id: 'integration-auth:google',
			kind: 'integration-auth',
			title: 'Google · kent@gmail.com stopped working',
			why: 'The provider rejected the saved sign-in.',
			href: '/connect/oauth?provider=google',
		}),
		item({
			id: 'secret-expired:one',
			kind: 'secret-expired',
			title: 'one expired',
			severity: 'degraded',
			doLabel: 'Update secret',
			href: '/account/secrets/user/one',
		}),
		item({
			id: 'secret-expired:two',
			kind: 'secret-expired',
			title: 'two expired',
			severity: 'degraded',
			doLabel: 'Update secret',
			href: '/account/secrets/user/two',
		}),
		item({
			id: 'secret-expired:three',
			kind: 'secret-expired',
			title: 'three expired',
			severity: 'degraded',
			doLabel: 'Update secret',
			href: '/account/secrets/user/three',
		}),
		item({
			id: 'onboarding:connect-agent',
			kind: 'onboarding',
			title: 'Connect an agent',
			severity: 'setup',
			href: '/onboarding',
		}),
	]
	expect(selectSearchWaitingItems(items).map((row) => row.id)).toEqual([
		'integration-auth:google',
		'secret-expired:one',
		'secret-expired:two',
		'secret-expired:three',
	])
	const markdown = formatSearchWaitingMarkdown({
		items,
		origin: 'https://example.com/',
	})
	expect(markdown).toContain('## Waiting')
	expect(markdown).toContain('stopped working')
	expect(markdown).toContain('one expired')
	expect(markdown).toContain('two expired')
	expect(markdown).not.toContain('three expired')
	expect(markdown).toContain('1 more · waitingSummary')
	expect(markdown).toContain('/account/waiting')

	expect(
		toSearchWaitingStructured({
			items,
			origin: 'https://example.com/',
		}),
	).toMatchObject({
		count: 4,
		items: [
			{ id: 'integration-auth:google' },
			{ id: 'secret-expired:one' },
			{ id: 'secret-expired:two' },
		],
	})

	expect(
		formatSearchWaitingMarkdown({
			items: [
				item({
					id: 'onboarding:connect-agent',
					kind: 'onboarding',
					title: 'Connect an agent',
					severity: 'setup',
				}),
			],
			origin: 'https://example.com',
		}),
	).toBeNull()
})
