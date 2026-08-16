# 0018: Inbound CLA for external contributions to this repository

- **Status:** accepted
- **Date:** 2026-08-16

## Context

This repository is Fair Source under [FSL-1.1-ALv2](../../../LICENSE). Copyright
is held by Kent C. Dodds as the sole Licensor. FSL's competing-use restriction,
two-year Apache 2.0 conversion, and any later relicensing or commercial license
only work cleanly when one party can speak as "We" for the whole tree.

GitHub's inbound-same-license rule is not enough here. It licenses a patch under
FSL, but it does not grant relicensing rights, a contributor patent license, or
a warranty that the contributor (or their employer) actually owns the patch. A
Developer Certificate of Origin records provenance only; it does not move those
rights.

The repo is public and has already merged outside human commits, including
substantial UI work. Almost all other history is Kent C. Dodds and allowlisted
automation (Cursor, Kody, Devin, Sentry, Dependabot). Community packages are a
separate MIT surface and are not this question.

Alternatives considered:

- **Rely on GitHub TOS / implicit FSL inbound.** Fine for same-license use;
  insufficient for relicensing, enforcement, patents, or employer IP.
- **DCO only.** Right tool for Apache/MIT projects; wrong tool for a
  single-licensor Fair Source tree.
- **Copyright assignment.** Heavier than needed; inbound license is enough.
- **Close the repo to outside pull requests.** Legally simplest, but the repo is
  already public and has taken outside patches. Issues and community packages
  remain the preferred place for most work; they do not replace a rule for the
  patches that do land here.

## Decision

Require a signed **inbound Contributor License Agreement** (not assignment)
before merging a pull request that includes commits from anyone other than the
Licensor or an allowlisted bot.

The contributor keeps copyright. They grant Kent C. Dodds a perpetual,
worldwide, irrevocable, sublicensable copyright and patent license, including
the right to relicense the contribution under FSL-1.1-ALv2, Apache 2.0, and any
commercial or other terms the Licensor offers. They represent that they have the
right to grant that license (and employer permission when the work is not theirs
alone).

How it works:

- **Scope.** This git repository only. User packages, community listings (MIT),
  and unsubmitted forks are out of scope.
- **Who signs.** Every GitHub identity that authors a commit on the pull
  request, unless that identity is `kentcdodds`, `kody-bot`, a `*[bot]` or
  `app/*` account, or an email listed as Licensor-owned in
  [`.github/cla-signers.json`](../../../.github/cla-signers.json).
- **Which form.** [Individual CLA](../../legal/individual-cla.md) by default.
  [Entity CLA](../../legal/entity-cla.md) when the work is owned by an employer
  or the contributor is signing for an organization.
- **How they sign.** Read the CLA, then comment on the pull request:
  `I have read the CLA and I hereby sign the CLA`. A maintainer records the
  GitHub username in `.github/cla-signers.json` on `main`. Signing covers past,
  present, and future contributions from that identity.
- **Enforcement.** The `CLA` workflow reads signers from `main` (never from the
  pull request head), fails closed on unsigned identities, and comments with the
  signing steps. Maintainers do not merge a red `CLA` check. There is no
  trivial-contribution exception.
- **Existing commits.** History is not rewritten. People who already contributed
  are asked to sign before the next merge; the CLA text covers prior
  contributions once signed.

## Consequences

- The Licensor stays one party for FSL, the Apache conversion, relicensing, and
  enforcement.
- Outside pull requests take one extra maintainer step (record the signer on
  `main`). That matches current volume. If volume grows, replace the manual
  record with a hosted CLA Assistant gist pointed at the same documents; do not
  adopt an unmaintained `pull_request_target` signing bot.
- Community package authors keep their own MIT copyright; they never sign this
  CLA unless they also patch this repository.
- Revisit if the Licensor becomes a company (assign the inbound grants to that
  successor), if counsel revises the CLA text, or if contribution volume
  justifies hosted click-to-sign.
