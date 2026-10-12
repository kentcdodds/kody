import {
	PrimitiveWidgetFrame,
	primitiveRestScene,
} from '#client/primitive-widgets.tsx'
import {
	primitiveCards,
	primitiveFeatureHref,
} from '#universal/primitive-cards.ts'
import { routes } from '#universal/routes.ts'

/**
 * Homepage cards: a small copy of each `/features` widget beside the
 * primitive's name and one line. The widget is decorative (the card is one
 * link); `/features` has the interactive versions. Narrow screens turn the
 * grid into a swipe row so six cards do not become six screens of scroll.
 */
export function LandingPrimitiveCards() {
	return () => (
		<section aria-labelledby="primitive-cards-title" class="landing-pcards">
			<h2 id="primitive-cards-title" class="landing-section-heading">
				See each one <em>at work</em>
			</h2>
			<ul class="landing-pcards-list">
				{primitiveCards.map((card) => (
					<li key={card.id} class="landing-pcard-item">
						<a
							href={primitiveFeatureHref(card.id)}
							class="landing-pcard"
							style={{ '--pw-accent': `var(--primitive-${card.id})` }}
						>
							<PrimitiveWidgetFrame id={card.id} size="mini">
								{primitiveRestScene(card.id)}
							</PrimitiveWidgetFrame>
							<span class="landing-pcard-name">{card.name}</span>
							<span class="landing-pcard-title">{card.title}</span>
						</a>
					</li>
				))}
			</ul>
			<p class="landing-pcards-more">
				<a href={routes.features.href()} class="landing-inline-link">
					Explore all features <span aria-hidden="true">↗</span>
				</a>
			</p>
		</section>
	)
}
