# Calibration and acceptance testing

The thresholds in `core/confidence/config.ts` are reasoned starting values.
They have not been validated against real citations, and shipping them unchecked
would put a number on a guess. This is how to fix that.

## Build the corpus

Collect 100–200 real citations you can verify by hand, weighted towards computer
science, and keep the messy ones: BibTeX copied from Google Scholar, arXiv
preprints of published papers, journal extensions of conference papers, entries
with abbreviated author lists, entries with a wrong DOI, entries with no DOI at
all, and a few pairs of genuinely different papers with the same title.

Record each as an entry in a JSON array; the shape is in
`tests/fixtures/citations/live-corpus.template.json`:

```json
{
  "id": "chi-2021-03",
  "category": "conference paper, no DOI in entry",
  "bib": "@inproceedings{...}",
  "truth": { "doi": "10.1145/...", "title": "...", "year": 2021, "venue": "...", "pages": "...", "ambiguous": false },
  "notes": "verified on the ACM DL page, 2026-09-22"
}
```

`truth.doi: null` means you verified the work has no DOI. Omit a field you did
not verify — the harness scores only what you assert, and calls the rest
unjudged. Mark `ambiguous: true` when the citation as written genuinely cannot
be resolved to one work.

Keep the corpus out of the repository if any of it is unpublished.

## Run it

```bash
npm run eval -- ../bibcleaner-corpus.json --email you@university.edu
```

It reports DOI discovery precision and recall, incorrect DOI rate, field
correction precision, candidate top-1 accuracy, ambiguity detection accuracy, a
calibration table of top-1 precision above each score threshold, and every wrong
suggestion by id. Responses are cached in `.cache/eval-cache.json`, so repeat
runs are fast and polite to the services.

## What to change

Read the calibration table first: it shows how often the selected candidate is
actually the right work at each score. Set `THRESHOLDS.veryHigh` where precision
is effectively 100%, `high` where it is still above roughly 95%, and `possible`
where matches stop being worth showing. Then re-run.

**The release gate is the last line of the report: the incorrect
high-confidence correction rate must be zero.** The harness exits non-zero when
it is not. Fix a failure by tightening the rule that produced it or lowering the
confidence it claims — never by loosening the truth data. Every failure that
survives a fix belongs in the golden corpus as a regression fixture.

Re-run whenever scoring, matching or suggestion logic changes.
