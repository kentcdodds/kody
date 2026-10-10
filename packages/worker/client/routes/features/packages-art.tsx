import { type Handle } from 'remix/component'
export function PackagePublishArt() {
	return () => (
		<svg
			class="pt-press"
			viewBox="0 0 520 170"
			role="img"
			aria-label="Source changes pass through publishing to become the code that runs"
		>
			<g fill="none" stroke="currentColor" stroke-width="2">
				<path d="M40 136V32h110l24 24v80z" />
				<path d="M150 32v24h24M65 76h82M65 94h62M65 112h76" />
				<path
					class="pt-publish-path"
					d="M190 85h122m-12-8 12 8-12 8"
					stroke="var(--accent)"
				/>
				<rect x="330" y="40" width="150" height="100" rx="5" />
				<path d="M330 65h150M347 88h110M347 108h76" />
			</g>
			<text x="49" y="160">
				Repo source
			</text>
			<text x="214" y="66">
				Publish
			</text>
			<text x="348" y="160">
				Runs here
			</text>
		</svg>
	)
}
export function PackageShareArt(
	handle: Handle<{ sharing: string; copyEdited: boolean }>,
) {
	return () => {
		const { sharing, copyEdited } = handle.props
		return (
			<svg
				viewBox="0 0 520 370"
				role="img"
				aria-label="One shared package or two independently owned copies"
			>
				<g class="pt-shared-drawing" hidden={sharing === 'fork'}>
					<path
						class="pt-wire"
						d="M110 285V235Q110 210 150 210H370Q410 210 410 235V285M260 210V160"
					/>
					<g class="pt-box" transform="translate(200 45)">
						<path d="M0 35 60 0 120 35 60 70Z" />
						<path d="M0 35v75l60 35 60-35V35M60 70v75M30 18l60 35" />
					</g>
					<text x="260" y="250" text-anchor="middle">
						One live package
					</text>
				</g>
				<g class="pt-fork-drawing" hidden={sharing !== 'fork'}>
					<path
						class="pt-wire"
						d="M260 25v32Q260 75 225 75H110v45M260 57q0 18 35 18h115v45"
					/>
					<g class="pt-box" transform="translate(50 105)">
						<path d="M0 35 60 0 120 35 60 70Z" />
						<path d="M0 35v75l60 35 60-35V35M60 70v75" />
					</g>
					<g class="pt-box pt-copy-box" transform="translate(350 105)">
						<path d="M0 35 60 0 120 35 60 70Z" />
						<path d="M0 35v75l60 35 60-35V35M60 70v75" />
					</g>
					<text x="110" y="280" text-anchor="middle">
						Weekly brief
					</text>
					<text x="410" y="280" text-anchor="middle">
						{copyEdited ? 'Customer brief' : 'Weekly brief'}
					</text>
				</g>
				<g fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="110" cy="315" r="12" />
					<path d="M87 351q0-23 23-23t23 23" />
					<circle cx="410" cy="315" r="12" />
					<path d="M387 351q0-23 23-23t23 23" />
				</g>
				<text x="150" y="332">
					You
				</text>
				<text x="350" y="332" text-anchor="end">
					Teammate
				</text>
			</svg>
		)
	}
}
