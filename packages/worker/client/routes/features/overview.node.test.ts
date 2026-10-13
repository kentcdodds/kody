import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { FeaturesOverview } from './overview.tsx'
import { primitiveCards } from '#universal/primitive-cards.ts'

test('features overview gives every primitive card an interactive widget', async () => {
	const html = await renderToString(jsx(FeaturesOverview, {}))

	for (const card of primitiveCards) {
		expect(html).toContain(`data-primitive="${card.id}"`)
		expect(html).toMatch(
			new RegExp(`data-primitive="${card.id}"[^>]*--hue: \\d+;`),
		)
		expect(html).toContain(`class="pw pw-${card.id}"`)
		expect(html).toContain(`href="/features/${card.id}"`)
		expect(html).toContain(`<h2>${card.name}</h2>`)
		expect(html).toContain(`aria-label="${card.name} example"`)
	}
	expect(html.match(/data-size="full"/g)).toHaveLength(primitiveCards.length)
	expect(html.match(/role="group"/g)).toHaveLength(primitiveCards.length)
	expect(html.match(/aria-live="polite"/g)).toHaveLength(primitiveCards.length)
	for (const label of [
		'Ask Claude',
		'Ask Cursor',
		'Ask ChatGPT',
		'Fire webhook trigger',
		'Fire schedule trigger',
		'Fire email trigger',
		'Invoke from Claude',
		'Invoke from Cursor',
		'Invoke from ChatGPT',
		'Book Tue 10:00',
		'Book Wed 2:30',
		'Book Thu 9:15',
	]) {
		expect(html).toContain(`aria-label="${label}"`)
	}
	for (const label of [
		'api.stripe.com',
		'paste.example',
		'Publish a change',
		'Ask for times again',
		'Project intake',
		'Reading list',
		'Habit tracker',
	]) {
		expect(html).toMatch(new RegExp(`<button[^>]*>${label}</button>`))
	}
	expect(html).toContain('aria-pressed="true"')
	expect(html).toContain('aria-pressed="false"')
	expect(html).not.toContain('data-motion')
})
