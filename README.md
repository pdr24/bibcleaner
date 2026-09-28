# BibCleaner

A Chrome extension that checks one BibTeX entry at a time against scholarly
metadata sources, and proposes corrections you approve one by one. It runs
entirely on your machine: no account, no server, no analytics, and no language
model at runtime.

Two modes:

- **Verify** — is this citation correct? Reports what matches, what conflicts,
  and what could not be checked. Proposes fixes only where your entry
  contradicts the record.
- **Clean & enrich** — everything Verify does, plus missing fields (DOI, venue,
  pages, publisher), capitalization protection, author and DOI normalization,
  layout, and a citation key that follows your scheme.

Nothing is applied unless you accept it. The entry you get back is your
original text with only the approved edits patched in; comments, custom fields,
macros and spacing you did not touch stay exactly as they were.

## Install

```bash
npm install
npm run build          # type-check, bundle, copy manifest and icons into dist/
```

Then open `chrome://extensions`, turn on Developer mode, choose **Load
unpacked**, and select the `dist` folder.

## Use

- Click the toolbar icon and paste one entry.
- Or select BibTeX on any page, right-click, and choose **Clean or verify
  BibTeX**.
- Or open a `.bib` file from the tab view and pick the entry you want. The file
  is read in the page and never uploaded; other entries in it are used only to
  resolve `@string` macros, `crossref` inheritance and citation-key collisions.

The results view shows your entry with a proof mark beside each field, the
checks that were run, and the suggested changes grouped by kind. Each change has
a **Why?** drawer with the value every source reported and a link to the record.
Accept the ones you want, then copy or download the result.

## What it talks to

Crossref, DataCite, DBLP, OpenAlex, arXiv and doi.org. Only the fields needed for
a lookup are sent: DOI, title, first author surname and year. Checking a citation
`url` is a separate, explicit action that asks for permission for that one site.

## Scripts

| Command                       | What it does                                                   |
| ----------------------------- | -------------------------------------------------------------- |
| `npm test`                    | Unit, golden-corpus and fuzz tests                             |
| `npm run typecheck`           | `tsc --noEmit`                                                 |
| `npm run build`               | Production build into `dist/`                                  |
| `npm run eval -- corpus.json` | Accuracy run against the live APIs (see `docs/CALIBRATION.md`) |
| `python3 tests/e2e/ui_e2e.py` | Browser test of the built UI with mocked APIs                  |

## Layout

```
core/        parsing, normalization, matching, scoring, suggestions, patching
sources/     one adapter per metadata service
ui/          React review interface (no Chrome APIs outside ui/platform.ts)
extension/   manifest, popup shell, context-menu service worker
tests/       unit, golden corpus, fuzz, browser end-to-end
scripts/     build helpers and the accuracy harness
docs/        engineering rules, privacy, calibration
```

`core/` and `sources/` have no dependency on Chrome or on React, so they can be
tested and reused outside the extension.

## Testing

`npm test` covers the parser, normalisation, scoring, adapters, the suggestion
engine and the approval rules, including a golden corpus of synthetic fixtures
and fuzz tests. The browser suites need Python with Playwright
(`pip install playwright && playwright install chromium`) and a build in
`dist/`; they mock every scholarly API, so they never touch the network.
`docs/QA-REPORT.md` records the pre-release testing pass and the defects it
found.

## Status

The engine, review interface and packaging are complete and tested; a full QA,
security and reliability pass has been done (`docs/QA-REPORT.md`). Confidence
thresholds in `core/confidence/config.ts` are reasoned starting values that have
**not** yet been calibrated against real citations; do that before release, as
described in `docs/CALIBRATION.md`.
