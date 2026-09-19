import { css } from 'remix/ui'
import {
	fieldCss,
	fieldLabelCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import {
	defaultFeatureFlagAudience,
	type FeatureFlagAudience,
} from '#universal/feature-flags/audiences.ts'

const selectCss = getSelectCss()

/**
 * Remix applies `defaultValue` as an HTML attribute, which `<select>` ignores.
 * Set `selected` on each option so saved audience hydrates after load/remount.
 */
export function renderAdminFeatureFlagAudienceField(input: {
	audience: FeatureFlagAudience | undefined
	disabled: boolean
}) {
	const audience = input.audience ?? defaultFeatureFlagAudience
	return (
		<label mix={css(fieldCss)}>
			<span mix={css(fieldLabelCss)}>Audience</span>
			<select name="audience" disabled={input.disabled} mix={css(selectCss)}>
				<option value="everyone" selected={audience === 'everyone'}>
					Everyone
				</option>
				<option
					value="experiments_opt_in"
					selected={audience === 'experiments_opt_in'}
				>
					Experiments opt-in
				</option>
			</select>
		</label>
	)
}
