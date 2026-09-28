"""
End-to-end check of the built extension UI (dist/) in Chromium.
Scholarly APIs are mocked with synthetic 10.5555 records; DBLP is made
to rate-limit in the popup run so graceful degradation is exercised too.
Run: npm run build && python3 tests/e2e/ui_e2e.py
"""
import json, re, subprocess, sys, time, pathlib
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / "tests" / "e2e" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

BIB = """@inproceedings{smith2025ai,
  title={using ai for iot security in smart homes},
  author={Smith, John and Doe, Jane},
  year={2025},
  mynote={keep me}
}"""

REC = {
    "DOI": "10.5555/1000001", "title": ["Using AI for IoT Security in Smart Homes"],
    "author": [{"given": "John", "family": "Smith"}, {"given": "Jane", "family": "Doe"}],
    "issued": {"date-parts": [[2024, 6]]}, "container-title": ["Proceedings of the 2024 ACM Conference on Example Security"],
    "type": "proceedings-article", "page": "120-131", "publisher": "ACM",
}
DBLP = {"result": {"hits": {"hit": [{"info": {
    "title": "Using AI for IoT Security in Smart Homes.", "authors": {"author": [{"text": "John Smith"}, {"text": "Jane Doe"}]},
    "venue": "EXSEC", "year": "2024", "pages": "120-131", "type": "Conference and Workshop Papers", "key": "conf/exsec/SmithD24",
    "doi": "10.5555/1000001", "ee": "https://doi.org/10.5555/1000001"}}]}}}

FAIL_DBLP = {"on": False}

def route(r):
    u = r.request.url
    if "dblp.org" in u and FAIL_DBLP["on"]:
        return r.fulfill(status=429, headers={"retry-after": "0"}, body="")
    if "api.crossref.org/works?" in u:
        return r.fulfill(status=200, content_type="application/json", body=json.dumps({"message": {"items": [REC]}}))
    if "api.crossref.org/works/" in u:
        return r.fulfill(status=200, content_type="application/json", body=json.dumps({"message": REC}))
    if "dblp.org/search" in u:
        return r.fulfill(status=200, content_type="application/json", body=json.dumps(DBLP))
    if "api.openalex.org" in u:
        return r.fulfill(status=429, headers={"retry-after": "0"}, body="")
    if "doi.org/api/handles" in u:
        return r.fulfill(status=200, content_type="application/json", body=json.dumps({"responseCode": 1, "values": [{"type": "URL", "data": {"value": "https://example.org/p"}}]}))
    return r.fulfill(status=404, body="")

def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8765", "-d", str(ROOT / "dist")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    errors = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            for view, width in (("tab", 1320), ("popup", 760)):
                FAIL_DBLP["on"] = view == "popup"
                pg = b.new_page(viewport={"width": width, "height": 1000 if view == "tab" else 600})
                pg.on("pageerror", lambda e: errors.append(str(e)))
                pg.route("https://**/*", route)
                q = "?view=tab" if view == "tab" else ""
                pg.goto(f"http://localhost:8765/popup/index.html{q}")
                pg.fill("#bib-in", BIB)
                pg.screenshot(path=str(OUT / f"{view}-1-input.png"), full_page=True)
                pg.get_by_role("button", name="Analyze").click()
                expect(pg.get_by_role("heading", name="Suggested changes")).to_be_visible(timeout=15000)
                # Nothing is accepted by default: Cleaned == Original.
                cleaned = pg.locator(".bibout").inner_text()
                assert cleaned.strip() == BIB.strip(), "cleaned output changed before any approval"
                if view == "popup":
                    # the reason is named alongside the source, e.g. "DBLP (rate limited) could not be checked"
                    body = pg.inner_text("body")
                    assert re.search(r"DBLP \(rate limited\) could not be checked", body), "unavailable source not reported with its reason"
                pg.screenshot(path=str(OUT / f"{view}-2-results.png"), full_page=True)
                # Accept the year correction and DOI; open evidence.
                yr = pg.locator("li.sg", has_text="2024").filter(has_text="year").first
                yr.get_by_text("Accept", exact=True).click()
                yr.get_by_role("button", name="Why?").click()
                doi = pg.locator("li.sg", has=pg.locator("code", has_text="10.5555/1000001")).filter(has_text="doi").first
                doi.get_by_text("Accept", exact=True).click()
                pg.get_by_role("tab", name="Diff").click()
                diff = pg.locator(".diff").inner_text()
                assert "year" in diff and "10.5555/1000001" in diff, diff
                pg.get_by_role("tab", name="Cleaned").click()
                cleaned = pg.locator(".bibout").inner_text()
                assert "mynote={keep me}" in cleaned, "custom field lost"
                assert "smith2025ai" in cleaned, "key changed without approval"
                pg.get_by_role("tab", name="Diff").click()
                pg.screenshot(path=str(OUT / f"{view}-3-reviewed.png"), full_page=True)
                # Accept all must not rename the key.
                pg.get_by_role("button", name="Accept all").click()
                pg.get_by_role("tab", name="Cleaned").click()
                assert "smith2025ai" in pg.locator(".bibout").inner_text(), "Accept all renamed the key"
                pg.screenshot(path=str(OUT / f"{view}-4-accept-all.png"), full_page=True)
                pg.close()
            # Multi-entry selection -> picker
            pg = b.new_page(viewport={"width": 1320, "height": 900})
            pg.route("https://**/*", route)
            pg.goto("http://localhost:8765/popup/index.html?view=tab")
            pg.fill("#bib-in", BIB + "\n\n@article{jones2024, title={Another Paper}, author={Jones, A.}, year={2024}}")
            pg.get_by_role("button", name="Analyze").click()
            expect(pg.get_by_text("Multiple BibTeX entries detected")).to_be_visible()
            pg.screenshot(path=str(OUT / "tab-5-picker.png"), full_page=True)
            b.close()
    finally:
        srv.terminate()
    if errors:
        print("Page errors:", errors); sys.exit(1)
    print("e2e OK; screenshots in", OUT)

main()
