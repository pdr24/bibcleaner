"""
QA end-to-end pass over the built extension UI (dist/) in Chromium.

Covers the release-critical UI behaviour that unit tests cannot reach:
the approval invariant through real clicks, untrusted-metadata rendering
(XSS), stale-request handling, offline and rate-limited states, ambiguity,
malformed input, copy/download fidelity and basic accessibility.

Run: npm run build && python3 tests/e2e/qa_e2e.py
"""
import json, re, subprocess, sys, time, pathlib, threading
from playwright.sync_api import sync_playwright, expect, Error as PWError

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "e2e" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)
FAILURES = []

def check(cond, msg):
    if not cond:
        FAILURES.append(msg)
        print("  FAIL:", msg)
    else:
        print("  ok:", msg)

TITLE = "Using AI for IoT Security in Smart Homes"
BIB = """@inproceedings{smith2025ai,
  title={using ai for iot security in smart homes},
  author={Smith, John and Doe, Jane},
  year={2025},
  mynote={keep me}
}"""

def crossref_item(title=TITLE, doi="10.5555/1000001", authors=(("John", "Smith"), ("Jane", "Doe")), year=2024):
    return {
        "DOI": doi, "title": [title],
        "author": [{"given": g, "family": f} for g, f in authors],
        "issued": {"date-parts": [[year, 6]]},
        "container-title": ["Proceedings of the 2024 ACM Conference on Example Security"],
        "type": "proceedings-article", "page": "120-131", "publisher": "ACM",
    }

DBLP_HIT = {"result": {"hits": {"hit": [{"info": {
    "title": TITLE + ".", "authors": {"author": [{"text": "John Smith"}, {"text": "Jane Doe"}]},
    "venue": "EXSEC", "year": "2024", "pages": "120-131", "type": "Conference and Workshop Papers",
    "key": "conf/exsec/SmithD24", "doi": "10.5555/1000001", "ee": "https://doi.org/10.5555/1000001"}}]}}}

class Mock:
    """Routing rules for the scholarly APIs, with per-scenario overrides."""
    def __init__(self, items=None, dblp=True, status=None, delay_ms=0, offline=False):
        self.items = items if items is not None else [crossref_item()]
        self.dblp = dblp
        self.status = status or {}
        self.delay_ms = delay_ms
        self.offline = offline
        self.log = []

    def handle(self, route):
        u = route.request.url
        self.log.append(u)
        if self.offline:
            return route.abort("internetdisconnected")
        if self.delay_ms:
            time.sleep(self.delay_ms / 1000)
        for frag, status in self.status.items():
            if frag in u:
                return route.fulfill(status=status, headers={"retry-after": "0"}, body="")
        if "api.crossref.org/works?" in u:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"message": {"items": self.items}}))
        if "api.crossref.org/works/" in u:
            doi = u.split("/works/")[1].split("?")[0].replace("%2F", "/")
            hit = next((i for i in self.items if i["DOI"].lower() == doi.lower()), None)
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"message": hit})) if hit else route.fulfill(status=404, body="{}")
        if "dblp.org/search" in u:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps(DBLP_HIT if self.dblp else {"result": {"hits": {}}}))
        if "doi.org/api/handles" in u:
            return route.fulfill(status=200, content_type="application/json",
                                 body=json.dumps({"responseCode": 1, "values": [{"type": "URL", "data": {"value": "https://example.org/p"}}]}))
        if "api.openalex.org" in u or "api.datacite.org" in u:
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"results": [], "data": []}))
        return route.fulfill(status=404, body="")

def new_page(browser, mock, width=1320, height=1100):
    pg = browser.new_page(viewport={"width": width, "height": height})
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None)
    pg.route("https://**/*", mock.handle)
    pg.route("http://**/*", lambda r: r.fulfill(status=404, body="") if "localhost:8765" not in r.request.url else r.continue_())
    pg.goto("http://localhost:8765/popup/index.html?view=tab")
    pg.wait_for_selector("#bib-in")
    return pg, errors

def analyze(pg, text):
    pg.fill("#bib-in", text)
    pg.get_by_role("button", name=re.compile("^(Analyze|Verify)$")).click()

def cleaned(pg):
    pg.get_by_role("tab", name="Cleaned").click()
    return pg.locator(".bibout").inner_text()

# ---------------------------------------------------------------- scenarios

def scenario_approval(b):
    print("\n[A] approval invariant through the UI")
    pg, errors = new_page(b, Mock())
    analyze(pg, BIB)
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    check(cleaned(pg).strip() == BIB.strip(), "nothing is applied before approval")
    tally = pg.locator(".tally").inner_text()
    check("0 accepted" in tally, f"tally starts at zero ({tally})")

    # accept exactly one suggestion
    year = pg.locator("li.sg", has_text="Change year").first
    year.get_by_text("Accept", exact=True).click()
    out = cleaned(pg)
    check("year={2024}" in out.replace(" ", ""), "accepted year is applied")
    check("10.5555/1000001" not in out, "no other suggestion leaked into the output")
    check("mynote={keep me}" in out, "custom field preserved")

    # reject it again -> original
    year.get_by_text("Reject", exact=True).click()
    check(cleaned(pg).strip() == BIB.strip(), "rejecting restores the original exactly")

    # accept all, then reject all
    pg.get_by_role("button", name="Accept all").click()
    after_all = cleaned(pg)
    check("smith2025ai" in after_all, "Accept all does not rename the citation key")
    check("keep me" in after_all, "Accept all keeps unknown fields")
    pg.get_by_role("button", name="Reject all").click()
    check(cleaned(pg).strip() == BIB.strip(), "Reject all returns the original citation")
    check(not errors, f"no page errors ({errors[:2]})")
    pg.screenshot(path=str(OUT / "qa-approval.png"), full_page=True)
    pg.close()

def scenario_xss(b):
    print("\n[B] untrusted metadata is rendered as text")
    payload = "<img src=x onerror=\"window.__pwned=1\">Using AI for IoT Security in Smart Homes"
    item = crossref_item(title=payload, doi="10.5555/1000001")
    item["publisher"] = "<script>window.__pwned=1</script>ACM"
    item["author"] = [{"given": "<svg onload=window.__pwned=1>", "family": "Smith"}, {"given": "Jane", "family": "Doe"}]
    pg, errors = new_page(b, Mock(items=[item], dblp=False))
    analyze(pg, BIB.replace("mynote={keep me}", 'mynote={<script>window.__pwned=1</script>}'))
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    check(pg.evaluate("() => window.__pwned === undefined"), "no injected script executed")
    check(pg.evaluate("() => document.querySelectorAll('script:not([src])').length === 0"), "no inline script element created")
    check(pg.evaluate("() => document.querySelectorAll('img[onerror], svg[onload]').length === 0"), "markup from metadata is not parsed as HTML")
    rendered = pg.inner_text("body")
    check("<script>window.__pwned=1</script>" in rendered, "the user's own markup is displayed verbatim as text")
    check(pg.evaluate("() => window.__pwned === undefined"), "still nothing executed after rendering")
    pg.close()

def scenario_stale(b):
    print("\n[C] a slow request never lands on a newer citation")
    slow = Mock(delay_ms=1200)
    pg, errors = new_page(b, slow)
    analyze(pg, BIB)                      # slow analysis of citation 1
    pg.wait_for_timeout(150)              # still in flight
    slow.delay_ms = 0
    pg.reload()                            # popup closed and reopened mid-lookup
    pg.wait_for_selector("#bib-in")
    other = "@article{other2020, title={A Completely Different Paper}, author={Nobody, A}, year={2020}}"
    analyze(pg, other)
    expect(pg.locator(".work-title, .panel h2").first).to_be_visible(timeout=15000)
    body = pg.content()
    check("A Completely Different Paper" in body or "No matching publication" in body, "the second citation's own result is shown")
    check(cleaned(pg).strip() == other.strip(), "output belongs to the citation on screen")
    check(not errors, f"no page errors ({errors[:2]})")
    pg.close()

    # rapid repeated Analyze clicks must not produce duplicate or mixed results
    pg, errors = new_page(b, Mock(delay_ms=150))
    pg.fill("#bib-in", BIB)
    for _ in range(5):
        try:
            pg.get_by_role("button", name=re.compile("^(Analyze|Verify)$")).click(timeout=500)
        except PWError:
            pass
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=20000)
    check(pg.locator(".work-title").count() == 1, "one result view after repeated Analyze clicks")
    check(not errors, f"no page errors on rapid clicks ({errors[:2]})")
    pg.close()

def scenario_modes(b):
    print("\n[D] verify mode versus clean & enrich")
    pg, errors = new_page(b, Mock())
    pg.get_by_text("Verify", exact=True).click()
    analyze(pg, BIB)
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    txt = pg.locator(".panel", has=pg.get_by_role("heading", name="Suggested changes")).inner_text()
    check("Formatting" not in txt, "verify mode offers no formatting changes")
    check("Citation key" not in txt, "verify mode does not rename keys")
    check("Change year" in txt, "verify mode still reports the wrong year")
    pg.get_by_text("Clean & enrich", exact=True).click()
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    txt2 = pg.locator(".panel", has=pg.get_by_role("heading", name="Suggested changes")).inner_text()
    check("Formatting" in txt2, "clean mode adds formatting changes")
    check(cleaned(pg).strip() == BIB.strip(), "switching modes never applies anything")
    pg.close()

def scenario_offline_and_limits(b):
    print("\n[E] offline and rate-limited states")
    pg, errors = new_page(b, Mock(offline=True))
    analyze(pg, BIB)
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=20000)
    body = pg.inner_text("body")
    check(re.search(r"could not be checked|offline|unavailable", body, re.I) is not None, "unreachable sources are reported")
    check("could not be checked" in body, "offline is described as unchecked, not as 'no match found'")
    check("No matching publication found" not in body, "offline never claims the publication does not exist")
    check(cleaned(pg).strip() == BIB.strip(), "offline output is unchanged")
    check(re.search(r"does not exist|no record for this DOI", body, re.I) is None, "offline is not reported as missing metadata")
    pg.screenshot(path=str(OUT / "qa-offline.png"), full_page=True)
    pg.close()

    pg, errors = new_page(b, Mock(status={"api.crossref.org": 429, "dblp.org": 429}))
    analyze(pg, BIB)
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=25000)
    body = pg.inner_text("body")
    check(re.search(r"rate limited", body, re.I) is not None, "rate limiting is named in the UI")
    # a plain "lookup failed" must carry the reason instead
    pg2, _ = new_page(b, Mock(status={"api.crossref.org": 400, "dblp.org": 400}))
    analyze(pg2, BIB)
    expect(pg2.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=25000)
    check("HTTP 400" in pg2.inner_text("body"), "a failed lookup names the reason in the summary")
    pg2.close()
    check(cleaned(pg).strip() == BIB.strip(), "rate-limited run changes nothing")
    pg.close()

def scenario_conflict_and_ambiguity(b):
    print("\n[F] conflict and ambiguity")
    wrong = crossref_item(title="Lattice Models of Protein Folding", doi="10.5555/9999999", authors=(("Ana", "Ruiz"),), year=2019)
    right = crossref_item()
    pg, errors = new_page(b, Mock(items=[wrong, right], dblp=False))
    analyze(pg, BIB.replace("mynote={keep me}", "doi={10.5555/9999999}"))
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    body = pg.inner_text("body")
    check("DOI belongs to a different work" in body, "a resolving but wrong DOI is reported as a conflict")
    check("Conflict" in body, "the conflict state is shown in words, not only colour")
    check("https://doi.org/10.5555/9999999" not in body, "no link is offered for the contradicted DOI")
    pg.get_by_role("button", name="Accept all").click()
    check("10.5555/9999999" not in cleaned(pg), "Accept all does not keep the wrong DOI anywhere")
    pg.screenshot(path=str(OUT / "qa-conflict.png"), full_page=True)
    pg.close()

    a1 = crossref_item(title="Neural Attention Models", doi="10.5555/A", authors=(("Ana", "Ruiz"),), year=2021)
    a2 = crossref_item(title="Neural Attention Models", doi="10.5555/B", authors=(("Bo", "Chen"),), year=2021)
    pg, errors = new_page(b, Mock(items=[a1, a2], dblp=False))
    analyze(pg, "@article{k, title={Neural Attention Models}, year={2021}}")
    expect(pg.locator(".panel.is-attention")).to_be_visible(timeout=15000)
    body = pg.inner_text("body")
    check("possible matches" in body.lower(), "multiple candidates are offered")
    sug = pg.locator(".panel", has=pg.get_by_role("heading", name="Suggested changes")).inner_text()
    check("Corrections" not in sug and "Missing information" not in sug, "no metadata suggestions while ambiguous")
    pg.get_by_text("None of these").click()
    check(cleaned(pg).strip().startswith("@article{k"), "choosing none keeps the citation intact")
    pg.screenshot(path=str(OUT / "qa-ambiguous.png"), full_page=True)
    pg.close()

def scenario_preprint(b):
    print("\n[G] preprint with a published version")
    pub = crossref_item(title="Graph Learning for Code Review", doi="10.5555/2000002", authors=(("Min", "Lee"),), year=2024)
    pg, errors = new_page(b, Mock(items=[pub], dblp=False))
    analyze(pg, "@article{lee2023,\n  title={Graph Learning for Code Review},\n  author={Lee, Min},\n  journal={arXiv preprint arXiv:2301.00001},\n  year={2023}\n}")
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    body = pg.inner_text("body")
    check("Published version" in body, "the published version is offered as its own decision")
    pg.get_by_role("button", name="Accept all").click()
    out = cleaned(pg)
    check("arXiv preprint arXiv:2301.00001" in out, "Accept all keeps the preprint citation")
    check("10.5555/2000002" not in out, "the published DOI is not substituted without approval")
    pg.get_by_role("button", name="Convert to published version").click()
    check("10.5555/2000002" in cleaned(pg), "explicit conversion applies the published version")
    pg.screenshot(path=str(OUT / "qa-preprint.png"), full_page=True)
    pg.close()

def scenario_malformed_and_files(b):
    print("\n[H] malformed input and multi-entry selection")
    mock = Mock()
    pg, errors = new_page(b, mock)
    analyze(pg, "@inproceedings{smith2025, title={unclosed")
    expect(pg.get_by_text("could not be parsed")).to_be_visible(timeout=10000)
    body = pg.inner_text("body")
    check("Nothing was sent" in body, "the user is told no lookup happened")
    check(not [u for u in mock.log if "crossref" in u or "dblp" in u], "no network request for unparseable input")
    check(not errors, f"no page errors on malformed input ({errors[:2]})")
    pg.close()

    pg, errors = new_page(b, Mock())
    analyze(pg, BIB + "\n\n@article{jones2024, title={Another Paper}, author={Jones, A.}, year={2024}}")
    expect(pg.get_by_text("Multiple BibTeX entries detected")).to_be_visible(timeout=10000)
    pg.get_by_role("button", name=re.compile("jones2024")).click()
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    out = cleaned(pg)
    check(out.strip().startswith("@article{jones2024"), "only the chosen entry is analyzed")
    check("smith2025ai" not in out, "the other entry is not part of the result")
    pg.close()

def scenario_output(b):
    print("\n[I] copy and download fidelity")
    pg, errors = new_page(b, Mock())
    analyze(pg, BIB)
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    pg.locator("li.sg", has_text="Change year").first.get_by_text("Accept", exact=True).click()
    shown = cleaned(pg)
    with pg.expect_download() as dl:
        pg.get_by_role("button", name="Download").click()
    path = dl.value.path()
    content = pathlib.Path(path).read_text()
    check(content.strip() == shown.strip(), "downloaded file matches the cleaned preview")
    check(content.endswith("\n"), "downloaded file ends with a newline")
    check("\r" not in content, "no stray carriage returns")
    check(dl.value.suggested_filename.endswith(".bib"), "download is named .bib")
    # diff shows exactly the accepted change
    pg.get_by_role("tab", name="Diff").click()
    diff = pg.locator(".diff").inner_text()
    check("year={2024}" in diff.replace(" ", ""), "diff shows the accepted change")
    check("10.5555/1000001" not in diff, "diff does not show rejected or undecided changes")
    pg.close()

def scenario_accessibility(b):
    print("\n[J] accessibility basics")
    pg, errors = new_page(b, Mock())
    analyze(pg, BIB)
    expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
    # states are conveyed in words
    body = pg.inner_text("body")
    check(re.search(r"High confidence|Verified|Conflict|Unverified", body) is not None, "verification state is written out")
    # tab list is keyboard navigable
    pg.get_by_role("tab", name="Original").focus()
    pg.keyboard.press("ArrowRight")
    focused = pg.evaluate("() => document.activeElement?.textContent")
    check(focused in ("Cleaned", "Diff"), f"arrow keys move between result tabs ({focused})")
    # every form control has an accessible name
    unlabeled = pg.evaluate("""() => [...document.querySelectorAll('button, input, select, textarea')]
        .filter(el => !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.textContent.trim() ||
                        (el.labels && el.labels.length) || el.getAttribute('title') || el.getAttribute('placeholder'))).length""")
    check(unlabeled == 0, f"all controls have accessible names ({unlabeled} without)")
    # focus is visible
    has_focus_rule = pg.evaluate("""() => [...document.styleSheets].flatMap(s => { try { return [...s.cssRules]; } catch { return []; } })
        .some(r => r.selectorText && r.selectorText.includes(':focus-visible') && /outline/.test(r.cssText))""")
    check(has_focus_rule, "a visible :focus-visible outline is defined")
    tag = pg.evaluate("() => { document.body.focus(); return document.activeElement?.tagName; }")
    check(tag is not None, "focus lands on a real element")
    # radio groups for accept/reject are real inputs
    check(pg.locator("fieldset.choice input[type=radio]").count() > 0, "accept/reject are radio inputs, not divs")
    pg.close()

def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", str(ROOT / "dist")],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for fn in (scenario_approval, scenario_xss, scenario_stale, scenario_modes, scenario_offline_and_limits,
                       scenario_conflict_and_ambiguity, scenario_preprint, scenario_malformed_and_files,
                       scenario_output, scenario_accessibility):
                try:
                    fn(b)
                except Exception as e:  # a scenario blowing up is itself a failure
                    FAILURES.append(f"{fn.__name__} raised {type(e).__name__}: {e}")
                    print("  ERROR:", fn.__name__, e)
            b.close()
    finally:
        srv.terminate()
    print("\n%d failure(s)" % len(FAILURES))
    for f in FAILURES:
        print(" -", f)
    sys.exit(1 if FAILURES else 0)

main()
