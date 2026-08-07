/**
 * Serializes document.startViewTransition calls so a superseding navigation
 * cannot call startViewTransition while a prior update callback is still
 * pending (Chrome throws InvalidStateError — KODY-CLOUDFLARE-3Y), and so
 * skip/abort rejections on the previous ViewTransition's lifecycle promises
 * never surface as unhandledrejection Sentry noise.
 */

export type ViewTransitionLike = {
	skipTransition(): void
	readonly updateCallbackDone: Promise<void>
	readonly ready: Promise<void>
	readonly finished: Promise<void>
}

export type ViewTransitionStarter = (
	callback: () => Promise<void>,
) => ViewTransitionLike

function ignoreRejection(promise: Promise<unknown>) {
	void promise.catch(() => {})
}

export function createViewTransitionScheduler(
	getStarter: () => ViewTransitionStarter | null,
) {
	let active: ViewTransitionLike | null = null
	/** Latest swap waiting to become a view transition (latest-wins). */
	let pendingSwap: (() => Promise<void>) | null = null
	let draining = false
	let chain: Promise<void> = Promise.resolve()

	function skipActive() {
		active?.skipTransition()
		active = null
	}

	/**
	 * Cancel in-flight and queued transitions before an instant (non-VT) swap
	 * so a later drain cannot restart a superseded view transition.
	 */
	function cancelPending() {
		pendingSwap = null
		skipActive()
	}

	async function drain() {
		while (pendingSwap) {
			const next = pendingSwap
			pendingSwap = null
			const start = getStarter()
			if (!start) {
				await next()
				continue
			}
			try {
				const transition = start(next)
				active = transition
				// skipTransition() rejects ready/finished; swallow so they
				// never become unhandledrejection.
				ignoreRejection(transition.ready)
				ignoreRejection(transition.finished)
				await transition.updateCallbackDone.catch(() => {})
			} catch {
				// startViewTransition threw (e.g. InvalidStateError) — swap
				// instantly rather than leaving the DOM on the old snapshot.
				await next()
			} finally {
				active = null
			}
		}
	}

	function run(swap: () => Promise<void>) {
		const startViewTransition = getStarter()
		if (!startViewTransition) {
			cancelPending()
			void swap()
			return
		}

		pendingSwap = swap
		skipActive()

		if (draining) return
		draining = true
		chain = chain
			.catch(() => {})
			.then(drain)
			.finally(() => {
				draining = false
				// A notify may have landed after drain emptied pendingSwap but
				// before draining flipped false; kick another pass if so.
				if (pendingSwap) {
					run(pendingSwap)
				}
			})
	}

	return {
		run,
		/** Cancel in-flight + queued transitions before an instant swap. */
		cancelPending,
		/** Test helper: resolves when the scheduled chain is idle. */
		whenIdle() {
			return chain.catch(() => {})
		},
	}
}
