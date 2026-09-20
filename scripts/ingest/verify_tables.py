"""CI gate: prove every hand-entered table value traces to the manual.

Runs offline, no API key. Three classes of check:
  1. PROVENANCE  - every `quote` is a verbatim substring of its cited page's text.
  2. NUMERACY    - every number asserted in a row appears in that row's quote.
  3. INVARIANTS  - domain rules that make a wrong table structurally impossible
                   (a lead cannot be in both sockets; DCEP must mean electrode-positive).

Exit 1 on any violation. This is the root of trust for the whole system: the
diagram verifier assumes these tables are correct, so they are checked here.
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGES = ROOT / "data" / "pages"
TABLES = ROOT / "data" / "tables"

violations: list[str] = []


def fail(msg: str) -> None:
    violations.append(msg)


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = text.replace("−", "-").replace("–", "-").replace("—", "-")
    text = text.replace("’", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", text).strip()


def page_text(n: int) -> str:
    p = PAGES / f"p{n:02d}.txt"
    if not p.exists():
        fail(f"page {n}: no extracted text (run extract_pages.py)")
        return ""
    return p.read_text(encoding="utf-8")


def check_quote(where: str, page: int, quote: str) -> bool:
    text = page_text(page)
    if not text:
        return False
    if normalize(quote) not in normalize(text):
        fail(f"{where}: quote not found verbatim on page {page}\n    quote: {quote[:110]}")
        return False
    return True


NUM = re.compile(r"\d+(?:\.\d+)?")


def check_numbers(where: str, values: list, quote: str) -> None:
    """Every number we assert must be present in the text we cite for it."""
    q = set(NUM.findall(normalize(quote)))
    for v in values:
        if v is None:
            continue
        s = f"{v:g}" if isinstance(v, (int, float)) else str(v)
        if s not in q:
            fail(f"{where}: value {s} is not present in the cited quote")


def verify_polarity() -> None:
    data = json.loads((TABLES / "polarity.json").read_text(encoding="utf-8"))
    seen = set()
    for row in data["rows"]:
        rid = row["id"]
        where = f"polarity[{rid}]"
        if rid in seen:
            fail(f"{where}: duplicate row id")
        seen.add(rid)

        # INVARIANT: the two leads cannot share a socket.
        if row["workLead"] == row["electrodeLead"]:
            fail(f"{where}: workLead and electrodeLead are both '{row['workLead']}'")

        # INVARIANT: the convention name must agree with the electrode lead.
        expected = "DCEP" if row["electrodeLead"] == "positive" else "DCEN"
        if row["convention"] != expected:
            fail(f"{where}: convention is {row['convention']} but electrodeLead "
                 f"is {row['electrodeLead']} (expected {expected})")

        # INVARIANT: this machine is DC only. No AC row may ever exist.
        if row["convention"] not in ("DCEP", "DCEN"):
            fail(f"{where}: non-DC convention '{row['convention']}' on a DC-only machine")

        if check_quote(where, row["page"], row["quote"]):
            q = normalize(row["quote"]).lower()
            # PROVENANCE: the quote must actually name both sockets.
            for lead, role in ((row["workLead"], "ground"), (row["electrodeLead"], "electrode")):
                if lead not in q:
                    fail(f"{where}: quote does not mention the {role} lead socket '{lead}'")

    print(f"  polarity: {len(data['rows'])} rows")


def verify_duty_cycle() -> None:
    data = json.loads((TABLES / "duty-cycle.json").read_text(encoding="utf-8"))
    for row in data["rows"]:
        where = f"duty_cycle[{row['id']}]"
        pts = row["points"]

        if check_quote(where, row["page"], row["quote"]):
            vals = []
            for p in pts:
                vals += [p["dutyPct"], p["amps"], p["arcVolts"]]
            vals += [row["outputRange"]["maxAmps"], row["outputRange"]["minAmps"]]
            check_numbers(where, vals, row["quote"])

        # INVARIANT: duty percentage falls as current rises.
        amps = [p["amps"] for p in pts]
        duty = [p["dutyPct"] for p in pts]
        if amps != sorted(amps, reverse=True):
            fail(f"{where}: points are not ordered by descending amperage")
        if duty != sorted(duty):
            fail(f"{where}: duty percentage does not rise as amperage falls")

        # INVARIANT: the published ceiling must be the highest point we hold.
        if row["maxPublishedAmps"] != max(amps):
            fail(f"{where}: maxPublishedAmps={row['maxPublishedAmps']} "
                 f"but highest published point is {max(amps)} A")

        # INVARIANT: if the machine outputs more than we publish, say so explicitly.
        reach = row["outputRange"]["maxAmps"]
        if reach > max(amps) and row.get("unpublishedAbove") is None:
            fail(f"{where}: machine reaches {reach} A but only {max(amps)} A is "
                 f"published, and unpublishedAbove is null")
        if row.get("unpublishedAbove") is not None and row["unpublishedAbove"] != max(amps):
            fail(f"{where}: unpublishedAbove must equal maxPublishedAmps")

    for c in data["specTableCorroboration"]:
        check_quote(f"duty_cycle.corroboration[{c['process']}]", c["page"], c["quote"])

    # THE decisive cross-check: same amperage, same input, different answer.
    by = {(r["process"], r["inputVoltage"]): r for r in data["rows"]}
    tig = next(p for p in by[("TIG", 240)]["points"] if p["amps"] == 175)
    stick = next(p for p in by[("Stick", 240)]["points"] if p["amps"] == 175)
    if tig["dutyPct"] == stick["dutyPct"]:
        fail("duty_cycle: 175 A @ 240 V must differ between TIG and Stick "
             "(30% vs 25%); if these match, the table has collapsed the process key")
    print(f"  duty_cycle: {len(data['rows'])} rows "
          f"(175A@240V -> TIG {tig['dutyPct']}% vs Stick {stick['dutyPct']}%)")


def verify_diagnosis() -> None:
    data = json.loads((TABLES / "diagnosis.json").read_text(encoding="utf-8"))
    counts = {}
    for sym in data["symptoms"]:
        where = f"diagnosis[{sym['id']}]"
        if check_quote(where, sym["page"], sym["quote"]):
            q = normalize(sym["quote"])
            # PROVENANCE: every cause and fix must be printed in the cited quote.
            for c in sym["causes"]:
                if normalize(c["cause"]) not in q:
                    fail(f"{where}: cause {c['n']} '{c['cause']}' not in the cited quote")
                if normalize(c["fix"]) not in q:
                    fail(f"{where}: fix for cause {c['n']} not in the cited quote")
        counts[sym["symptom"]] = counts.get(sym["symptom"], {})
        counts[sym["symptom"]][sym["appliesTo"][0]] = len(sym["causes"])

        # INVARIANT: a gas-only cause cannot be listed for a gasless process.
        if sym["appliesTo"] == ["Stick"]:
            for c in sym["causes"]:
                if "shielding gas" in c["cause"].lower():
                    fail(f"{where}: stick welding has no shielding gas, "
                         f"but cause {c['n']} cites it")

    # INVARIANT: the process-conditional asymmetry must survive. If these ever
    # match, someone has merged the two porosity sections and the agent will
    # start telling stick users to increase their gas flow.
    por = counts.get("porosity", {})
    if por.get("MIG") == por.get("Stick"):
        fail("diagnosis: porosity cause counts are equal across MIG and Stick; "
             "the process gating has collapsed")
    print(f"  diagnosis: porosity MIG={por.get('MIG')} causes, "
          f"Stick={por.get('Stick')} causes")


def verify_unanswerable() -> None:
    data = json.loads((TABLES / "unanswerable.json").read_text(encoding="utf-8"))
    corpus = normalize(" ".join(page_text(n) for n in range(1, 49)))

    for gap in data["gaps"]:
        where = f"unanswerable[{gap['id']}]"
        ev = gap["evidence"]
        # Verify the NEGATIVE claim: a probe we assert is absent must be absent.
        if "absence" in ev:
            probe = ev["absence"]["probe"]
            found = corpus.count(normalize(probe))
            if found != ev["absence"]["occurrencesInManual"]:
                fail(f"{where}: absence probe '{probe}' claimed "
                     f"{ev['absence']['occurrencesInManual']} occurrences, found {found}")
        for p in ev.get("pointers", []):
            check_quote(f"{where}.pointer(p{p['page']})", p["page"], p["quote"])

    # INVARIANT: no pointer may be dressed up as the source of the settings
    # matrix. This entry once asserted the matrix was "a decal on the inside of
    # the welder door" -- an inference from the manual pointing at that decal
    # five times, written down as a fact. The decal is now ingested and does not
    # contain it. Three of those five pointers are about gas flow, one is about
    # tungsten sizing on a different decal entirely.
    gap = next((g for g in data["gaps"] if g["id"] == "settings_matrix_not_in_manual"), None)
    if gap:
        claim = normalize(gap["claim"]).lower()
        if "is a decal" in claim or "on the inside of the welder door" in claim:
            fail("unanswerable[settings]: the claim says the matrix IS on the door decal. "
                 "It is not -- the decal carries the Auto Weld procedure and duty cycles. "
                 "Do not re-introduce an inference as a finding.")
        for ptr in gap["evidence"].get("pointers", []):
            if ptr.get("claimsSettingsMatrix") is not False:
                fail(f"unanswerable[settings].pointer(p{ptr['page']}): must record "
                     f"claimsSettingsMatrix:false -- read the quote, it does not say that")
            if not ptr.get("asksFor"):
                fail(f"unanswerable[settings].pointer(p{ptr['page']}): record what the "
                     f"pointer actually asks for, so nobody re-reads it as the matrix")

    for c in data["contradictions"]:
        where = f"contradiction[{c['id']}]"
        check_quote(where, c["page"], c["quote"])
        if not c["refutedBy"]:
            fail(f"{where}: a contradiction must cite what refutes it")
        for r in c["refutedBy"]:
            check_quote(f"{where}.refutedBy(p{r['page']})", r["page"], r["quote"])

    print(f"  unanswerable: {len(data['gaps'])} gaps, "
          f"{len(data['contradictions'])} contradiction(s)")


def verify_settings_procedure() -> None:
    """The synergic procedure -- the honest answer to 'what voltage and wire speed?'."""
    data = json.loads((TABLES / "settings-procedure.json").read_text(encoding="utf-8"))

    syn = data["synergic"]
    check_quote("settings.synergic", syn["page"], syn["quote"])
    # The 'settings are approximate' caveat is on the door decal and nowhere else.
    # Verify the NEGATIVE claim instead: if this word ever turns up in the manual,
    # the caveat should be promoted to a text-verified citation.
    approx = syn["approximateNote"]
    if approx.get("textVerifiable") is not False:
        fail("settings.synergic.approximate: decal-sourced, must stay textVerifiable:false")
    corpus = normalize(" ".join(page_text(n) for n in range(1, 49))).lower()
    if "approximate" in corpus:
        fail("settings.synergic.approximate: 'approximate' now appears in the manual "
             "text -- promote this caveat to a page citation")

    for proc in data["processes"]:
        where = f"settings[{proc['id']}]"
        if not check_quote(where, proc["page"], proc["quote"]):
            continue
        q = normalize(proc["quote"])

        # PROVENANCE: the gas range we print must be in the quote we cite for it.
        if proc["gasScfh"]:
            check_numbers(where, [proc["gasScfh"]["min"], proc["gasScfh"]["max"]], proc["quote"])

        # PROVENANCE: every knob assignment must be printed on the cited page.
        for s in proc["youSet"]:
            if s["sets"].lower() not in q.lower():
                fail(f"{where}: quote does not say the {s['knob']} sets '{s['sets']}'")

        # INVARIANT: the operator sets a DIAMETER and a THICKNESS; the machine
        # derives the electrical settings. If a process ever claims the operator
        # sets voltage or wire speed directly, the synergic model has been lost
        # and the configurator would start inventing numbers.
        sets = " ".join(s["sets"] for s in proc["youSet"]).lower()
        if "thickness" not in sets:
            fail(f"{where}: no input sets material thickness")
        if "voltage" in sets or "feed speed" in sets:
            fail(f"{where}: operator inputs must not include derived electrical settings")

    print(f"  settings: {len(data['processes'])} synergic procedures (machine derives A/V)")


def verify_process_selection() -> None:
    """The image-only chart. Different rule: corroborate what can be, admit the rest."""
    data = json.loads((TABLES / "process-selection.json").read_text(encoding="utf-8"))

    # INVARIANT: this table must keep declaring itself unverifiable against text.
    # If someone 'fixes' that flag, these claims start wearing a provenance badge
    # they have not earned.
    if data["source"]["textVerifiable"] is not False:
        fail("process_selection: source must stay textVerifiable:false -- it is a "
             "zero-character PDF and nothing in it can be traced to page text")

    sel = ROOT / "data" / "docs" / "sel-p1.txt"
    if sel.exists() and sel.read_text(encoding="utf-8").strip():
        fail("process_selection: selection-chart.pdf now yields text; re-check whether "
             "this table can be promoted to text-verified")

    for row in data["rows"]:
        where = f"process_selection[{row['id']}]"
        t = row["thickness"]
        if t["minIn"] >= t["maxIn"]:
            fail(f"{where}: thickness range is inverted ({t['minIn']} >= {t['maxIn']})")
        # Corroboration is optional, but when claimed it must resolve.
        if row.get("corroboration"):
            page_text(row["corroboration"]["page"])

    # INVARIANT: the chart's own generic duty-cycle example must never be flagged
    # as a rating for this welder. 165 A @ 30% is Harbor Freight boilerplate; this
    # machine's 30% point is 175 A, and confusing the two is a burnt machine.
    ex = data["dutyCycleDefinition"]["genericExample"]
    if ex["isRatingForThisMachine"] is not False:
        fail("process_selection: the chart's 165 A example is generic, not a rating")
    duty = json.loads((TABLES / "duty-cycle.json").read_text(encoding="utf-8"))
    rated = {p["amps"] for r in duty["rows"] for p in r["points"]}
    if ex["amps"] in rated:
        fail(f"process_selection: generic example {ex['amps']} A collides with a real "
             f"rated point; the guard below can no longer tell them apart")

    # INVARIANT: the machine is DC-only, so the chart's AC-TIG materials must never
    # appear as materials this welder can TIG.
    tig = next(r for r in data["rows"] if r["id"] == "tig")
    for m in tig.get("materialsRequiringAcTig", []):
        if m in tig["materials"]:
            fail(f"process_selection[tig]: '{m}' requires AC TIG and cannot be listed "
                 f"as a material this DC-only machine welds")

    print(f"  process_selection: {len(data['rows'])} processes from an image-only chart "
          f"(not text-verifiable, by design)")


def main() -> None:
    print("verifying tables against extracted manual text...")
    verify_polarity()
    verify_duty_cycle()
    verify_diagnosis()
    verify_unanswerable()
    verify_settings_procedure()
    verify_process_selection()

    if violations:
        print(f"\nFAILED: {len(violations)} violation(s)\n")
        for v in violations:
            print(f"  - {v}")
        sys.exit(1)
    print("\nOK: every table value traces to its cited page.")


if __name__ == "__main__":
    main()
