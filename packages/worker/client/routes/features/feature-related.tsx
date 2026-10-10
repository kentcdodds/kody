import { type Handle } from 'remix/component'

export type FeatureRelatedLink = {
	href: string
	label: string
}

export function FeatureRelated(
	handle: Handle<{ links: Array<FeatureRelatedLink> }>,
) {
	return () => {
		const { links } = handle.props
		if (links.length === 0) return null
		return (
			<section
				class="feature-related story-section"
				aria-labelledby="feature-related"
			>
				<h2 id="feature-related">Related</h2>
				<ul class="feature-related-list">
					{links.map((link) => (
						<li key={link.href}>
							<a href={link.href}>{link.label}</a>
						</li>
					))}
				</ul>
			</section>
		)
	}
}
