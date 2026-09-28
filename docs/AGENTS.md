# Working on BibCleaner

Read this before changing anything in `core/` or `sources/`. The rules below
come from the product requirements and are restated here because they are what
makes the tool trustworthy. A change that improves coverage but breaks one of
them is a regression.

## The fifteen rules

1. **Never change a citation without explicit approval.** Not even whitespace,
   not even an obviously correct DOI format. Suggestions arrive as
   `accepted: null` and stay that way until the user decides.
2. **Never invent metadata.** Every proposed value comes from a source record or
   from a deterministic rule applied to the user's own text.
3. **A DOI that resolves is not a correct DOI.** Resolution proves the handle
   exists. Only comparing the registered metadata with the citation says whether
   it is the right work.
4. **A source that could not be reached is not a source that disagreed.**
   `LOOKUP FAILED`, `RATE LIMITED` and `NETWORK UNAVAILABLE` must never be
   reported as "not found", and must never lower confidence in the citation.
5. **Surface ambiguity instead of guessing.** When two candidates are close,
   present both and suggest nothing until the user picks one.
6. **A preprint and its published version are different records.** Offer the
   conversion; never perform it as part of a general clean.
7. **Every change carries its provenance.** Field, old value, new value, reason,
   confidence and the per-source evidence that supports it.
8. **Preserve everything you do not understand.** Unknown fields, comments,
   macros, duplicate fields and the user's spacing survive untouched.
9. **Optimize against false corrections, not for coverage.** A missed
   improvement costs a user nothing. A confident wrong correction corrupts a
   bibliography silently. When in doubt, say less.
10. **Confidence must be earned by evidence.** Identifier agreement outranks
    string similarity; sparse citations cannot reach high confidence on a single
    matching field.
11. **Critical contradictions override scores.** A DOI registered to another
    title, a different author list or a large year gap blocks a VERIFIED state
    however high the total is.
12. **Formatting is separate from facts.** Capitalization, dash style, name
    order and layout are presentation; they are grouped apart from metadata
    corrections so a user can take one without the other.
13. **Unverifiable is a state, not an error.** Report what was not checked and
    why, in the same language every time.
14. **The user's data stays with the user.** No citation text, no file contents
    and no usage record leaves the machine except the minimum query fields sent
    to the metadata services.
15. **Everything ships with the extension.** No remote code, no `eval`, no
    dynamic imports; `scripts/copy-manifest.mjs` fails the build if any appear.

## Invariants the tests enforce

- `applySuggestions(text, suggestions)` returns `text` byte-for-byte when
  nothing is accepted, and touches only the spans of accepted changes otherwise
  (`tests/unit/formatter.test.ts`, `tests/unit/fuzz.test.ts`).
- No golden-corpus fixture produces a HIGH or VERY HIGH metadata correction on a
  citation that should not be corrected (`tests/integration/corpus.test.ts`).
- No network call happens for input that does not parse.
- Adapters return `LookupResult`, never `Work | null`, so callers cannot lose the
  difference between "absent" and "unavailable".

Add a fixture to `tests/fixtures/citations/corpus.ts` for every behaviour you
change. Adversarial cases — same title different authors, same author similar
title different venue — are more valuable than happy paths.

## Where things live

- `core/parser/bibtex.ts` — span-preserving scanner. It records byte offsets for
  every field so edits can be applied as minimal patches. Do not replace it with
  a parser that returns only values.
- `core/confidence/` — weights, thresholds and scoring. Thresholds are
  constants on purpose; they are meant to be calibrated, not hard-coded in
  branches elsewhere.
- `core/verification/evaluate.ts` — turns a comparison into suggestions. This is
  where most accuracy work happens; each suggestion needs a reason a user can
  act on and evidence for the "Why?" drawer.
- `ui/` — React only. Chrome APIs are confined to `ui/platform.ts` so the
  interface runs in a plain browser tab for development and testing.

## Permissions

`contextMenus` and `storage` are the only permissions, plus host access to the
six metadata APIs. URL checking uses optional host permissions requested at the
moment the user presses **Check URL**. Do not add `tabs`, `scripting`,
`webRequest`, `cookies`, `history` or `<all_urls>`; if a feature seems to need
one, it needs a different design.
