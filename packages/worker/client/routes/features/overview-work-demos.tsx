import { on, type Handle } from 'remix/component'
export function TriggersOverviewDemo(handle: Handle) {
	let ran = false
	return () => (
		<div class="demo" aria-label="Triggers example">
			<div class="event-flow">
				<div>↗ Purchase received</div>
				<span aria-hidden="true">↓</span>
				<div>ƒ Purchase thanks</div>
				<span aria-hidden="true">↓</span>
				<div aria-live="polite">
					{ran ? '✓ Draft ready for your review' : 'Thank-you draft for review'}
				</div>
			</div>
			<button
				type="button"
				class="demo-action"
				mix={on('click', () => {
					ran = true
					handle.update()
				})}
			>
				Run example ↗
			</button>
		</div>
	)
}
export function IntegrationsOverviewDemo(handle: Handle) {
	let account = 'work'
	return () => (
		<div class="demo" aria-label="Integrations example">
			<div class="mini">
				<div class="chrome">
					Google <span>2 accounts</span>
				</div>
				<button
					type="button"
					class="account"
					aria-pressed={account === 'personal'}
					mix={on('click', () => {
						account = 'personal'
						handle.update()
					})}
				>
					<span>google-personal</span>
					<span>Personal{account === 'personal' ? ' ✓' : ''}</span>
				</button>
				<button
					type="button"
					class="account"
					aria-pressed={account === 'work'}
					mix={on('click', () => {
						account = 'work'
						handle.update()
					})}
				>
					<span>google-work</span>
					<span>Work{account === 'work' ? ' ✓' : ''}</span>
				</button>
				<div class="receipt" aria-live="polite">
					{account === 'work'
						? 'weekly-brief → Work calendar'
						: 'weekly-brief → Personal calendar'}
				</div>
			</div>
		</div>
	)
}
export function AppsOverviewDemo(handle: Handle) {
	let project = 'Autumn launch'
	let saved = ''
	return () => (
		<div class="demo" aria-label="Apps example">
			<form
				class="mini"
				mix={on('submit', (event) => {
					event.preventDefault()
					if (!project.trim()) return
					saved = project.trim()
					handle.update()
				})}
			>
				<div class="chrome">
					● ● ● <span>project-intake</span>
				</div>
				<strong>Project brief</strong>
				<label class="project-field">
					Project name
					<input
						value={project}
						required
						mix={on('input', (event) => {
							project = event.currentTarget.value
							handle.update()
						})}
					/>
				</label>
				<button type="submit" class="save">
					Save brief
				</button>
				<div class="receipt" aria-live="polite">
					{saved
						? `Saved “${saved}” in this demo.`
						: 'Interactive example, saved in this page only'}
				</div>
			</form>
		</div>
	)
}
