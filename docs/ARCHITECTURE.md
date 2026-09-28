# How a citation flows through BibCleaner

```
paste / selection / .bib file
   │
   ├─ parse            core/parser/bibtex.ts      keeps byte offsets, mutates nothing
   ├─ structure        core/verification/         entry type, required fields, macros, braces
   ├─ normalize        core/normalize/            LaTeX ⇄ Unicode, authors, DOI, pages, venue
   │
   ├─ identifiers      sources/doiResolver.ts     does the DOI exist?
   │                   sources/crossref|datacite  what is it registered to?
   │                   sources/arxiv              preprint, and its published DOI
   ├─ discovery        Crossref → DBLP → OpenAlex, stopping as soon as a match is strong
   │
   ├─ candidates       core/matcher/candidates.ts merge records per work, group versions
   ├─ score            core/confidence/           weighted fields, critical contradictions
   ├─ evaluate         core/verification/evaluate compare fields, produce suggestions
   │
   ├─ review           ui/review/                 nothing accepted by default
   └─ apply            core/formatter/apply.ts    patch only the approved spans
```

Three decisions shape everything else.

**The parser keeps spans.** Every field records where its name and value start
and end in the source. An accepted change becomes a patch over that span, so the
output is the user's own text with holes punched in it rather than a
regenerated entry. This is what makes "never change anything silently"
enforceable rather than aspirational.

**Adapters return outcomes, not values.** `lookupByDOI` returns a
`LookupResult` whose status distinguishes a record, no record, a failure, a rate
limit and being offline. Nothing downstream can accidentally read "Crossref was
down" as "Crossref has never heard of this DOI".

**Suggestions are data.** Each one is a patch plus a reason, confidence, the
evidence behind it, and a tri-state decision. The interface renders them; it
does not compute them. That is why the review rules are unit-testable
(`ui/review/review.ts`) and why the same engine drives the accuracy harness.

## Scoring in one paragraph

Title, authors, venue, year and publisher are compared and weighted (0.35,
0.30, 0.15, 0.10, 0.10), renormalized over whatever is actually comparable, and
capped when only one component is present, so a bare title match cannot reach
high confidence. A matching identifier supersedes the string score. Critical
contradictions — the DOI is registered to a different title, the author lists
disagree, the years differ by more than one, the venue and year both differ —
block a VERIFIED state and downgrade the result no matter what the total says.

## Known limits

- Selection text from a web page may arrive with newlines collapsed; the
  content is intact but the layout suggestion will want to reformat it.
- Checking a `url` that redirects to another domain needs permission for that
  domain too. Without it the check reports "could not be checked", never
  "unreachable".
- DNS rebinding is out of scope for the URL safety check: the hostname is
  validated before the request and the final URL is re-validated, but the
  browser resolves the name.
- OpenAlex and Crossref rate-limit anonymous clients more aggressively; adding a
  contact e-mail in settings helps on large sessions.
