import { on, type Handle } from 'remix/component'
export function MemoryOverviewDemo(handle: Handle) {
	let found = false
	return () => (
		<div class="demo" aria-label="Memory example">
			<div class="mini">
				<div class="chrome">
					Writing preference <span>Saved</span>
				</div>
				<strong>
					Lead with the decision.
					<br />
					Keep updates short.
				</strong>
				<div class="receipt" aria-live="polite">
					{found
						? 'Next agent found your project-update preference.'
						: 'Available to your connected agents'}
				</div>
			</div>
			<button
				type="button"
				class="demo-action"
				mix={on('click', () => {
					found = true
					handle.update()
				})}
			>
				Try another agent ↗
			</button>
		</div>
	)
}
export function SecretsOverviewDemo(handle: Handle) {
	let sent = false
	return () => (
		<div class="demo" aria-label="Secrets example">
			<div class="mini">
				<div class="chrome">
					API credential <span>Stored</span>
				</div>
				<div class="masked">••••••••••••</div>
				<div class="kv">
					<span>Allowed host</span>
					<code>api.example.com</code>
				</div>
				<div class="receipt" aria-live="polite">
					{sent
						? 'Credential attached for the approved host.'
						: 'Your agent uses a reference to the key.'}
				</div>
			</div>
			<button
				type="button"
				class="demo-action"
				mix={on('click', () => {
					sent = true
					handle.update()
				})}
			>
				Send example request ↗
			</button>
		</div>
	)
}
export function PackagesOverviewDemo(handle: Handle) {
	let tab = 'result'
	return () => (
		<div class="demo" aria-label="Packages example">
			<div class="mini">
				<div class="chrome">
					◇ weekly-brief <span>Published</span>
				</div>
				<div class="tabs">
					<button
						type="button"
						aria-pressed={tab === 'result'}
						mix={on('click', () => {
							tab = 'result'
							handle.update()
						})}
					>
						Result
					</button>
					<button
						type="button"
						aria-pressed={tab === 'source'}
						mix={on('click', () => {
							tab = 'source'
							handle.update()
						})}
					>
						Source
					</button>
				</div>
				<pre aria-live="polite">
					{tab === 'source'
						? 'weekly-brief/\n  README.md\n  AGENTS.md\n  src/brief.ts'
						: 'Orchard: design review is ready.\nFieldwork: kickoff is booked.'}
				</pre>
			</div>
		</div>
	)
}
