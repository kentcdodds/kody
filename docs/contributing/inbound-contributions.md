# Inbound contributions

How outside patches enter [this repository](https://github.com/kentcdodds/kody).
The decision and the why live in
[0018 — Inbound CLA](./decisions/0018-inbound-cla.md).

This page is the platform-repo contribution path. Most reusable behavior belongs
in a [community package](../use/community-packages.md) (MIT, your copyright).
You do not sign a CLA to publish or fork a community listing.

## What needs a CLA

A pull request needs a signed Contributor License Agreement when any commit on
it is authored by someone other than Kent C. Dodds or an allowlisted bot.

The contributor keeps copyright. The CLA is an inbound license so the repository
can stay a single-licensor Fair Source tree under [FSL-1.1-ALv2](../../LICENSE).

Sign the [Individual CLA](../legal/individual-cla.md) unless an employer owns
the work. If an organization owns the work, an authorized representative
completes the [Entity CLA](../legal/entity-cla.md) instead.

There is no exception for docs-only or one-line patches.

## How to sign (individual)

1. Open the pull request.
2. Read the [Individual CLA](../legal/individual-cla.md).
3. Comment exactly:

   ```
   I have read the CLA and I hereby sign the CLA
   ```

4. The `CLA` workflow records your GitHub username in
   [`.github/cla-signers.json`](../../.github/cla-signers.json) on `main` and
   re-runs the check.

Signing once covers past, present, and future contributions from that GitHub
identity. Unsigned prior contributors sign the same way before their next merge.
The workflow reads signers from `main`, not from the pull request branch, so
adding your own username on the branch does not pass the check. Only the
commenter is recorded, and only from the exact phrase.

## How to sign (entity)

An authorized representative emails
[me@kentcdodds.com](mailto:me@kentcdodds.com) with:

- subject `Kody Entity CLA`
- legal name and address of the organization
- representative name and title
- GitHub usernames authorized to submit on the organization's behalf
- a statement that the organization accepts the
  [Entity CLA](../legal/entity-cla.md)

Licensor records those usernames after accepting the agreement.

## Who does not sign

These identities are allowlisted in `.github/cla-signers.json` and do not sign:

- `kentcdodds` (Licensor)
- `kody-bot` and other logins listed in that file
- `cursoragent` (Cursor Cloud Agent commit author)
- Licensor-owned commit emails listed in that file
- GitHub accounts whose login ends in `[bot]` or starts with `app/`

Cursor Cloud Agent pull requests follow the Licensor path even when GitHub
authors the pull request as `kentcdodds` and the commits as `cursoragent`.

## Maintainer steps

Do not merge a pull request while the `CLA` check is red.

Individual signatures are recorded automatically from the signing comment. After
an accepted Entity CLA, add each authorized username to
`.github/cla-signers.json` on `main` with `signedAt` as an ISO date
(`YYYY-MM-DD`) and `cla` of `entity`.

Make the `CLA` check required for `main` in GitHub branch protection so a green
review cannot skip it.

## Out of scope

- Publishing or forking community packages
- Issues, discussions, and security reports that do not include a patch
- Private vulnerability reports ([Security policy](../../SECURITY.md))
