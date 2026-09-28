# Privacy

BibCleaner has no backend. There is no account, no telemetry, no crash
reporting, and no language model call at any point.

## What leaves your machine

Only lookups, and only to these services:

| Service  | Sent                                                   | When                                                 |
| -------- | ------------------------------------------------------ | ---------------------------------------------------- |
| doi.org  | the DOI in your entry                                  | the entry has a DOI                                  |
| Crossref | the DOI, or title words, first author surname and year | always in a lookup                                   |
| DataCite | the DOI, or title words                                | DOI is not in Crossref, or as a fallback             |
| DBLP     | title words                                            | searching, and for venue abbreviations when cleaning |
| OpenAlex | title words                                            | when nothing better was found                        |
| arXiv    | the arXiv identifier                                   | the entry has one                                    |

Your citation is never sent as a whole. Abstracts, notes, file paths, keywords
and any custom fields stay on your machine. If you add a contact e-mail in
settings it is sent to Crossref and OpenAlex only, to use their identified
request pools; leaving it empty is fine.

Checking a `url` field is a separate action you have to press. It asks for
permission for that one site, fetches the page once, and reads only its title
and any declared DOI.

## What is stored on your machine

- **Settings**, in extension storage.
- **A metadata cache**, in extension storage: public records keyed by DOI or by
  a hash of the query. Successful lookups are kept for 30 days and "no record
  found" for 24 hours, both configurable; failures are never cached. Clear it
  any time in settings.
- **Nothing else.** BibCleaner keeps no history of the citations you checked,
  the files you opened or the changes you accepted. Text handed over by the
  context menu lives in session storage and is deleted as soon as the page reads
  it.

## Permissions and why

- `contextMenus` — the right-click entry for selected text.
- `storage` — settings and the metadata cache.
- Host access to the six services above — the lookups themselves.
- Optional host access to other sites — requested only when you press
  **Check URL**, and removable from settings.

BibCleaner cannot read the pages you visit. The context menu receives the text
you selected and nothing else.
