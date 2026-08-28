import { jsx } from 'remix/ui/jsx-runtime'
import { renderToString } from 'remix/ui/server'
import { expect, test } from 'vitest'
import { pickWalkthroughHosts } from '#universal/walkthrough-hosts.ts'
import { HowKodyWorksWalkthrough } from './how-kody-works-walkthrough.tsx'
import { WalkthroughHostIntro } from './walkthrough-host-intro.tsx'

test('host intro and walkthrough bind picked agents; picker variant drops the story lead', async () => {
	const hosts = pickWalkthroughHosts(() => 0)
	const intro = await renderToString(
		jsx(WalkthroughHostIntro, {
			hosts,
			onHostsChange: () => {},
		}),
	)

	expect(intro).toContain(`value="${hosts.coding.id}"`)
	expect(intro).toContain(`value="${hosts.invoke.id}"`)
	expect(intro).toContain(`value="${hosts.notify.id}"`)
	expect(intro).toContain(`>${hosts.coding.label}</span>`)
	expect(intro).toContain(`/images/icons/${hosts.coding.icon}.svg`)
	expect(intro).toContain('aria-label="Regular coding agent"')
	expect(intro).toContain("Let's say you use")

	const picker = await renderToString(
		jsx(WalkthroughHostIntro, {
			hosts,
			variant: 'picker',
			onHostsChange: () => {},
		}),
	)
	expect(picker).toContain(`value="${hosts.coding.id}"`)
	expect(picker).toContain('aria-label="Regular coding agent"')
	expect(picker).not.toContain("Let's say you use")

	const walkthrough = await renderToString(
		jsx(HowKodyWorksWalkthrough, { hosts }),
	)
	expect(walkthrough).toContain("Let's say you use")
	expect(walkthrough).toContain(`>${hosts.coding.label}</figcaption>`)
	expect(walkthrough).toContain(`/images/icons/${hosts.coding.icon}.svg`)
	expect(walkthrough).toContain(`/images/icons/${hosts.invoke.icon}.svg`)
	expect(walkthrough).toContain(`/images/icons/${hosts.notify.icon}.svg`)
	expect(walkthrough).toContain(hosts.coding.label)
	expect(walkthrough).toContain(hosts.invoke.label)
	expect(walkthrough).toContain(hosts.notify.label)
	expect(walkthrough).not.toContain('You start on the computer with {coding}.')
	expect(walkthrough).not.toContain('Later, on your phone with {invoke}.')
	expect(walkthrough).not.toContain('Later still, with {notify}.')
})
