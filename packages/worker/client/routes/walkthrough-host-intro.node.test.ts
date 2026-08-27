import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { pickWalkthroughHosts } from '#universal/walkthrough-hosts.ts'
import { HowKodyWorksWalkthrough } from './how-kody-works-walkthrough.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'

test('host intro names the three story agents as styleable selects', async () => {
	const hosts = pickWalkthroughHosts(() => 0)
	let latest = hosts
	const html = await renderToString(
		jsx(WalkthroughHostIntro, {
			hosts,
			onHostsChange: (next) => {
				latest = next
			},
		}),
	)

	expect(html).toContain("Let's say you use")
	expect(html).toContain('as your regular coding agent')
	expect(html).toContain('as your chat agent on your phone')
	expect(html).toContain('as another agent you sometimes use')
	expect(html).toContain('connected to Kody')
	expect(html).toContain('aria-label="Regular coding agent"')
	expect(html).toContain('aria-label="Chat agent on your phone"')
	expect(html).toContain('aria-label="Another agent you sometimes use"')
	expect(html).toContain(`value="${hosts.coding.id}"`)
	expect(html).toContain(`value="${hosts.invoke.id}"`)
	expect(html).toContain(`value="${hosts.notify.id}"`)
	expect(html).toContain(`>${hosts.coding.label}</span>`)
	expect(html).toContain(`/images/icons/${hosts.coding.icon}.svg`)
	expect(html).toContain('@supports (appearance: base-select)')
	expect(html).toContain('@supports not (appearance: base-select)')
	expect(latest).toEqual(hosts)

	const picker = await renderToString(
		jsx(WalkthroughHostIntro, {
			hosts,
			variant: 'picker',
			onHostsChange: () => {},
		}),
	)
	expect(picker).toContain('Choose three agents you use:')
	expect(picker).toContain('I use')
	expect(picker).toContain('for daily coding')
	expect(picker).toContain('for phone chat')
	expect(picker).toContain('and sometimes')
	expect(picker).toContain('for coding too')
	expect(picker).toContain('aria-label="Regular coding agent"')
	expect(picker).toContain('aria-label="Chat agent on your phone"')
	expect(picker).toContain('aria-label="Another agent you sometimes use"')
	expect(picker).not.toContain("Let's say you use")
})

test('how-kody-works walkthrough uses the intro and host marks instead of the old lead', async () => {
	const hosts = pickWalkthroughHosts(() => 0)
	const html = await renderToString(jsx(HowKodyWorksWalkthrough, { hosts }))

	expect(html).toContain("Let's say you use")
	expect(html).not.toContain('A question you would ask again')
	expect(html).toContain(`>${hosts.coding.label}</figcaption>`)
	expect(html).toContain('What your agents')
	expect(html).toContain(`/images/icons/${hosts.coding.icon}.svg`)
	expect(html).toContain(`/images/icons/${hosts.invoke.icon}.svg`)
	expect(html).toContain(`/images/icons/${hosts.notify.icon}.svg`)
	expect(html).toContain('You start on the computer with')
	expect(html).toContain('Later, on your phone with')
	expect(html).toContain('Later still, with')
	expect(html).toContain('The next day')
	expect(html).toContain('Something shipped.')
	expect(html).toContain('kody-bot shipped 2 things')
	expect(html).toContain('kody-bot/lantern v1.4.1')
	expect(html).toContain('kody-bot/quiet-days v0.1.0')
	expect(html).toContain(hosts.coding.label)
	expect(html).toContain(hosts.invoke.label)
	expect(html).toContain(hosts.notify.label)
	expect(html).not.toContain('You start on the computer with {coding}.')
	expect(html).not.toContain('Later, on your phone with {invoke}.')
	expect(html).not.toContain('Later still, with {notify}.')
})
