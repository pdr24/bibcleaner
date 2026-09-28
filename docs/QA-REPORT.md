# Pre-release QA pass

Scope: testing, debugging, security, reliability and regression work on the
whole extension. Result: **ready with known non-blocking issues** — every
release-blocking defect found is fixed and covered by a regression test, and
the only thing outstanding before a real release is threshold calibration
(`docs/CALIBRATION.md`).

## Defects found and fixed

| ID    | Severity | Component                                            | Problem                                                                                                                                                                                                                     | Fix                                                                                                                                                                                                                                      | Regression test                                                                                                             |
| ----- | -------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| QA-01 | High     | `core/security/url.ts`                               | `http://localhost.` (trailing-dot FQDN) bypassed the local-network block; same for `*.local.`, `*.internal.`                                                                                                                | Trailing dots are stripped before every host comparison                                                                                                                                                                                  | `tests/unit/security-hard.test.ts`                                                                                          |
| QA-02 | High     | source adapters, `core/verification/pipeline.ts`     | A malformed API body (`{"results": "oops"}`) threw and aborted the whole analysis                                                                                                                                           | `asArray()` guards in every adapter, plus a `try/catch` in the pipeline so a throwing source is recorded as unavailable                                                                                                                  | `tests/unit/adapters-hard.test.ts`, `tests/integration/pipeline-hard.test.ts`                                               |
| QA-03 | Blocker  | `core/verification/evaluate.ts`                      | For a preprint with a published version, "Add URL from DOI" was categorised as formatting, so **Accept all** injected the published DOI into a preprint citation; the citation key was also built from the published record | DOI-derived values in version mode are `version` category; the key describes the entry as it stands until the conversion is approved                                                                                                     | `tests/integration/approval.test.ts`, corpus fixture _preprint citation: every published-version value is a version change_ |
| QA-04 | Blocker  | `core/confidence/score.ts`, `core/normalize/text.ts` | "Erratum: _Title_" scored 0.952 against the original paper and was marked VERIFIED with a VERY HIGH suggestion to adopt the erratum's DOI                                                                                   | `correctionMarker()` detects errata, corrigenda, retractions, comments, replies and editorials; a one-sided marker is a critical contradiction and blocks grouping. A contradicted candidate is never used to enrich identifiers or keys | corpus fixtures _erratum notice…_, _comment-on notice…_                                                                     |
| QA-05 | Medium   | `ui/useBibCleaner.ts`, `core/parser/bibtex.ts`       | Malformed BibTeX was reported as "No BibTeX entry found"; a key containing a space produced `Expected "=" but found ","`                                                                                                    | Unparseable text goes through analysis (no network) so the parse error, its line and the structural checks are shown; the parser names a key containing a space                                                                          | `tests/unit/cache-settings.test.ts`, e2e scenario H                                                                         |
| QA-06 | Medium   | `ui/useBibCleaner.ts`                                | A URL check finishing after the user moved on applied its result to the new citation                                                                                                                                        | Run-token guard, same pattern as `startAnalysis`                                                                                                                                                                                         | e2e scenario C                                                                                                              |
| QA-07 | Blocker  | `core/verification/evaluate.ts`                      | With a DOI registered to another work, "Add URL from DOI" offered `https://doi.org/<wrong doi>` at HIGH confidence inside the Formatting group                                                                              | A contradicted DOI is never turned into a link                                                                                                                                                                                           | `tests/integration/pipeline-hard.test.ts`, e2e scenario F                                                                   |
| QA-08 | High     | `sources/crossref/adapter.ts`                        | Every Crossref _search_ returned HTTP 400: the `select` list contained `subtype`, which is not on Crossref's whitelist, so the whole request was rejected. Only found against the live API — the mocks accepted any query   | Removed the invalid field, and a search rejected with HTTP 400 now retries once without `select`                                                                                                                                         | `tests/unit/adapters-hard.test.ts` (asserts every requested field is on the documented whitelist)                           |
| QA-09 | Medium   | `core/net/http.ts`, `ui/components/Match.tsx`        | A non-JSON response said only "Response was not valid JSON", and the summary said only "lookup failed", so a live failure could not be diagnosed from the UI                                                                | The detail names what arrived ("an HTML page", a body snippet) and the summary shows it for failed lookups                                                                                                                               | `tests/unit/adapters-hard.test.ts`, e2e scenario E                                                                          |
| QA-10 | High     | `sources/dblp/adapter.ts`                            | DBLP answered every search with an HTML page (HTTP 200). Its search box is a query language: a stray `-` (left by a dash or a hyphenated word) or a one-character token makes it return an error page instead of JSON       | `dblpQuery()` sends plain alphanumeric words of two characters or more, at most ten; nothing is sent when nothing searchable remains. One retry on a non-JSON body, and the HTTP status is now part of the message                       | `tests/unit/adapters-hard.test.ts`                                                                                          |
| QA-11 | Medium   | `sources/types.ts`                                   | Search queries were built from raw BibTeX, so `Na\"{\i}ve` was sent as the two fragments "Na ve" — worse matching for every accented or LaTeX-escaped title                                                                 | Queries decode LaTeX to Unicode and fold diacritics first ("Naive")                                                                                                                                                                      | `tests/unit/adapters-hard.test.ts`                                                                                          |

## Accuracy and presentation improvements

- Venue acronyms now match the initialism of the full name (`CCS` ↔ "…Computer
  and Communications Security" previously scored **0**, depressing match scores
  and risking a spurious venue correction).
- The match summary names _why_ a source could not be checked ("DBLP (rate
  limited) could not be checked").
- When every source is unreachable the headline reads "This citation could not
  be checked" rather than "No matching publication found": unavailable is not
  the same as absent.

## Test suites added

`parser-hard`, `security-hard`, `url-verify`, `adapters-hard`,
`confidence-hard`, `matching-hard`, `formatter-hard`, `cache-settings`,
`precedence-fields`, `integration/approval`, `integration/pipeline-hard`,
six new golden-corpus fixtures, and `tests/e2e/qa_e2e.py` (ten browser
scenarios: approval invariant, XSS, stale requests, modes, offline and rate
limiting, conflict and ambiguity, preprint, malformed input and `.bib`
selection, copy/download fidelity, accessibility).

Totals: **520 unit and integration tests**, ~60 browser assertions, clean
type-check, clean production build, Prettier clean.

## Known issues, not blocking

- Confidence thresholds are still uncalibrated. This is the release gate.
- `connect-src` in the CSP is `https: http:` because a user-initiated URL check
  can target any site; the real gate is the optional host permission, requested
  per site. `http://` citation URLs are likely to be blocked as mixed content
  and will surface as "could not be checked".
- `npm audit` reports advisories in `vite`, `vitest` and `esbuild`. All are
  development-only (`npm audit --omit=dev` is clean) and fixing them means
  major-version upgrades, which were not taken during a QA pass.
- Not exercised here: loading the packed extension in real Chrome, the
  context-menu service worker end to end, and `chrome.permissions.request`
  flows. Live API behaviour is only partly covered: QA-08 shows that mocks
  cannot catch a query the real service rejects, so a manual run against the
  live APIs belongs in any release checklist.
