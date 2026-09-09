import { expect, type Page } from '@playwright/test'

export type MainSnapshot = {
	h1: string
	status: string
	/** Visible paragraphs whose copy starts with "Loading". */
	loadingCopy: string
}

/**
 * Record every distinct state `<main>` passes through from now until read.
 * Navigation must swap the previous page for the next one in a single
 * commit: no intermediate state without an `<h1>` and no loading copy where
 * content was — that is the "flash of loading" these specs guard against.
 */
export async function observeMainTransitions(page: Page) {
	await page.evaluate(() => {
		const main = document.getElementById('main')
		if (!main) throw new Error('Expected #main')
		const snapshot = () => ({
			h1: main.querySelector('h1')?.textContent?.trim() ?? '',
			status: Array.from(main.querySelectorAll('[role="status"]'))
				.map((node) => node.textContent?.trim() ?? '')
				.join(' | '),
			loadingCopy: Array.from(main.querySelectorAll('p'))
				.map((node) => node.textContent?.trim() ?? '')
				.filter((text) => /^Loading/i.test(text))
				.join(' | '),
		})
		const log: Array<MainSnapshot> = [snapshot()]
		const observer = new MutationObserver(() => {
			const next = snapshot()
			const last = log[log.length - 1]
			if (
				last &&
				last.h1 === next.h1 &&
				last.status === next.status &&
				last.loadingCopy === next.loadingCopy
			) {
				return
			}
			log.push(next)
		})
		observer.observe(main, {
			childList: true,
			subtree: true,
			characterData: true,
		})
		Object.assign(window, { __kodyMainTransitions: log })
	})
}

export async function readMainTransitions(page: Page) {
	return page.evaluate(
		() =>
			(window as unknown as { __kodyMainTransitions: Array<MainSnapshot> })
				.__kodyMainTransitions,
	)
}

/**
 * Assert a recorded navigation went from `fromHeading` to `toHeading` without
 * blanking the page or showing loading copy in between.
 */
export function expectSingleCommitTransition(
	transitions: Array<MainSnapshot>,
	input: { fromHeading: string | RegExp; toHeading: string | RegExp },
) {
	const detail = JSON.stringify(transitions)
	expect(transitions[0]?.h1, detail).toMatch(input.fromHeading)
	expect(transitions.at(-1)?.h1, detail).toMatch(input.toHeading)
	for (const state of transitions) {
		// Every intermediate DOM state still shows a page title.
		expect(state.h1, detail).not.toBe('')
		// ...and never a loading message in place of content.
		expect(state.status, detail).not.toMatch(/loading/i)
		expect(state.loadingCopy, detail).toBe('')
	}
}

/**
 * Collect same-origin `.json` payload requests so a spec can assert the
 * destination payload is requested once (the router preloads it) and never
 * refetched by the route after commit.
 */
export function collectJsonRequests(page: Page) {
	const paths: Array<string> = []
	page.on('request', (request) => {
		const url = new URL(request.url())
		if (url.pathname.endsWith('.json')) paths.push(url.pathname)
	})
	return {
		paths,
		reset() {
			paths.splice(0)
		},
		duplicates() {
			const seen = new Set<string>()
			const repeated = new Set<string>()
			for (const path of paths) {
				if (seen.has(path)) repeated.add(path)
				seen.add(path)
			}
			return Array.from(repeated)
		},
	}
}
