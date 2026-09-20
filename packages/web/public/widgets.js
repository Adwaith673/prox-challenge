/**
 * Interactive widgets.
 *
 * The brief asks for interactive duty-cycle calculators, troubleshooting
 * flowcharts and settings configurators. The tempting way to build those is to
 * let the model emit HTML or JSX at runtime — which is the same mistake as
 * letting it free-draw an SVG, with more surface area, because now it authors
 * both the numbers and the logic that presents them.
 *
 * Here the controls are real and the data is not the model's to choose: every
 * value, branch and refusal arrives from the verified tables on the server. The
 * model picked which widget to show and nothing else. That makes this path
 * *stronger* than the diagram path, where it at least selects a table row.
 */

/* eslint-env browser */
(function () {
  const esc = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function field(label, opts, onChange) {
    const f = document.createElement("div");
    f.className = "wfield";
    const id = "w" + Math.random().toString(36).slice(2, 8);
    f.innerHTML =
      '<label for="' + id + '">' + esc(label) + "</label>" +
      '<select id="' + id + '">' +
      opts
        .map((o) => {
          const v = o && o.v !== undefined ? o.v : o;
          const t = o && o.t !== undefined ? o.t : o;
          return '<option value="' + esc(v) + '">' + esc(t) + "</option>";
        })
        .join("") +
      "</select>";
    f.querySelector("select").addEventListener("change", onChange);
    return f;
  }

  function numberField(label, value, onInput) {
    const f = document.createElement("div");
    f.className = "wfield";
    f.innerHTML =
      "<label>" + esc(label) + "</label>" +
      '<input type="number" value="' + value + '" min="1" max="400" step="5">';
    f.querySelector("input").addEventListener("input", onInput);
    return f;
  }

  /* ── duty cycle ──────────────────────────────────────────────────────── */
  function dutyCalculator(root, d) {
    const row = document.createElement("div");
    row.className = "wrow";
    const out = document.createElement("div");

    const processes = [...new Set(d.rows.map((r) => r.process))];
    const pf = field("Process", processes, update);
    const vf = field("Input voltage", [{ v: 240, t: "240 V" }, { v: 120, t: "120 V" }], update);
    const af = numberField("Amperage", 175, update);
    row.append(pf, vf, af);
    root.append(row, out);

    function update() {
      const proc = pf.querySelector("select").value;
      const volts = Number(vf.querySelector("select").value);
      const amps = Number(af.querySelector("input").value);
      const r = d.rows.find((x) => x.process === proc && x.inputVoltage === volts);

      if (!r) {
        out.innerHTML =
          '<div class="wout stop"><span class="big small">No such combination</span></div>';
        return;
      }

      const exact = r.points.find((pt) => pt.amps === amps);
      if (exact) {
        const mins = (exact.dutyPct / 10).toFixed(1).replace(/\.0$/, "");
        out.innerHTML =
          '<div class="wout"><span class="big">' + exact.dutyPct + "%</span>" +
          '<span class="note">' + exact.amps + " A at " + exact.arcVolts +
          " V arc — " + mins + " min of arc time in every " + d.periodMinutes +
          "-minute window, then rest.</span>" +
          '<span class="src">rated point · page ' + r.page + "</span></div>";
        return;
      }

      if (amps > r.maxPublishedAmps) {
        const why =
          r.unpublishedNote ||
          "Nothing is rated above " + r.maxPublishedAmps + " A for " + proc + " at " +
          volts + " V. The machine reaches " + r.reach + " A, but the manual does not rate it there.";
        out.innerHTML =
          '<div class="wout stop"><span class="big small">Not published</span>' +
          '<span class="note">' + esc(why) + "</span>" +
          '<span class="note"><strong>No estimate is offered.</strong> Duty cycle is a tested ' +
          "thermal result under IEC 60974-1, not a curve you can read between points.</span>" +
          '<span class="src">page ' + r.page + "</span></div>";
        return;
      }

      const above = [...r.points].sort((a, b) => a.amps - b.amps).find((pt) => pt.amps >= amps);
      out.innerHTML =
        '<div class="wout warn"><span class="big small">Between rated points</span>' +
        '<span class="note">The manual rates discrete currents only. Nearest published at or ' +
        "above " + amps + " A is <strong>" +
        (above ? above.dutyPct + "% at " + above.amps + " A" : "none") +
        "</strong>. Not interpolated.</span>" +
        '<span class="src">page ' + r.page + "</span></div>";
    }
    update();
  }

  /* ── troubleshooting ─────────────────────────────────────────────────── */
  function troubleshooting(root, d) {
    const row = document.createElement("div");
    row.className = "wrow";
    const out = document.createElement("div");

    const symptoms = [...new Set(d.symptoms.map((s) => s.symptom))];
    const sf = field("Symptom", symptoms, update);
    const pf = field("Process", ["MIG", "TIG", "Stick"], update);
    const vf = field("Wire type", [
      { v: "gas", t: "solid wire (gas)" },
      { v: "flux_cored_self_shielded", t: "flux-core (gasless)" },
    ], update);
    row.append(sf, pf, vf);
    root.append(row, out);

    function update() {
      const symptom = sf.querySelector("select").value;
      const proc = pf.querySelector("select").value;
      const gasless = vf.querySelector("select").value === "flux_cored_self_shielded";
      vf.style.display = proc === "MIG" ? "" : "none";

      const entry = d.symptoms.find((s) => s.symptom === symptom && s.appliesTo.indexOf(proc) >= 0);
      if (!entry) {
        out.innerHTML =
          '<div class="wout warn"><span class="big small">Not printed for ' + esc(proc) + "</span>" +
          '<span class="note">The manual has no ' + esc(symptom) +
          " section for this process, so there is nothing to quote.</span></div>";
        return;
      }

      const excluded = entry.causes.filter((c) => gasless && c.gasShieldedOnly);
      const apply = entry.causes.filter((c) => !(gasless && c.gasShieldedOnly));

      out.innerHTML =
        '<div class="steps">' +
        apply
          .map((c, i) =>
            '<div class="step"><span class="n">' + (i + 1) + "</span><div>" +
            "<b>" + esc(c.cause) + "</b><span>" + esc(c.fix) + "</span></div></div>")
          .join("") +
        excluded
          .map((c) =>
            '<div class="step off"><span class="n">–</span><div><b>' + esc(c.cause) + "</b>" +
            "<em>Excluded — self-shielded flux-core runs gasless.</em></div></div>")
          .join("") +
        "</div>" +
        '<div class="wout" style="margin-top:12px"><span class="note">The manual prints <strong>' +
        entry.causes.length + "</strong> cause" + (entry.causes.length === 1 ? "" : "s") +
        " for " + esc(proc) +
        (proc === "Stick"
          ? " — and stick uses no shielding gas, so gas-flow fixes are not among them"
          : "") +
        ".</span><span class=\"src\">page " + entry.page + "</span></div>";
    }
    update();
  }

  /* ── settings configurator ───────────────────────────────────────────── */
  /* This one answers. The machine is synergic, so the useful output is the knob
     sequence plus a range check — not a wire-speed table that does not exist. */
  function settingsConfigurator(root, d) {
    const row = document.createElement("div");
    row.className = "wrow";
    const out = document.createElement("div");

    const jf = field("Process", d.jobs.map((j) => ({ v: j.id, t: j.label })), update);
    const tf = field("Material thickness", d.thicknesses.map((t) => ({ v: t.in, t: t.label })), update);
    const wf = field("Wire / rod / electrode", d.diameters, update);
    row.append(jf, tf, wf);
    root.append(row, out);

    function update() {
      const job = d.jobs.find((j) => j.id === jf.querySelector("select").value);
      const tSel = tf.querySelector("select");
      const thickIn = Number(tSel.value);
      const thickLabel = tSel.options[tSel.selectedIndex].text;
      const dia = wf.querySelector("select").value;

      // Range check against the selection chart. Out of range is a real answer,
      // not a failure: it tells you to change process.
      const t = job.thickness;
      const below = thickIn < t.minIn;
      const above = thickIn > t.maxIn;
      const alt = d.jobs.filter(
        (j) => j.id !== job.id && thickIn >= j.thickness.minIn && thickIn <= j.thickness.maxIn,
      );

      let range;
      if (below || above) {
        range =
          '<div class="wout stop"><span class="big small">' + esc(thickLabel) + " is " +
          (above ? "thicker" : "thinner") + " than " + esc(job.label) + " is rated for</span>" +
          '<span class="note">The selection chart gives ' + esc(job.label) + " as <strong>" +
          esc(t.label) + "</strong>." +
          (alt.length
            ? " For " + esc(thickLabel) + " it points at <strong>" +
              alt.map((a) => esc(a.label)).join("</strong>, <strong>") + "</strong>."
            : " No process on this machine covers that thickness.") +
          "</span>" +
          '<span class="src">selection-chart.pdf — image only, no text layer</span></div>';
      } else {
        range =
          '<div class="wout"><span class="big small">' + esc(thickLabel) + " is in range for " +
          esc(job.label) + "</span>" +
          '<span class="note">Chart range <strong>' + esc(t.label) +
          "</strong> · " + esc(job.shieldingGas) + " · skill " + esc(job.skillLevel) +
          "</span>" +
          '<span class="src">selection-chart.pdf — image only, no text layer</span></div>';
      }

      // The actual procedure, from the process's own page.
      const steps = job.youSet
        .map((s, i) =>
          '<div class="step"><span class="n">' + (i + 1) + "</span><div><b>" +
          esc(s.knob) + "</b><span>set " + esc(s.sets) +
          (/diameter/i.test(s.sets) ? " — <strong>" + esc(dia) + "</strong>" : "") +
          (/thickness/i.test(s.sets) ? " — <strong>" + esc(thickLabel) + "</strong>" : "") +
          "</span></div></div>")
        .join("");

      const derived =
        '<div class="wout warn" style="margin-top:12px">' +
        '<span class="big small">The machine derives ' +
        esc(job.machineDerives.join(" and ")) + "</span>" +
        '<span class="note">' + esc(job.adjustStep) + "</span>" +
        '<span class="note">' + esc(d.synergic.quote) + "</span>" +
        '<span class="src">page ' + d.synergic.page + " · read the number off the display, " +
        "it is not printed anywhere</span></div>";

      const facts =
        '<div class="known">' +
        (job.gasScfh
          ? "<div><b>Gas flow</b><code>" + job.gasScfh.min + "–" + job.gasScfh.max +
            ' SCFH</code><i>p.' + job.page + "</i></div>"
          : "<div><b>Shielding gas</b><code>none required</code><i>p." + job.page + "</i></div>") +
        "<div><b>Polarity</b><code>" + esc(job.polarity.convention) + " — ground " +
        esc(job.polarity.workLead) + ", electrode " + esc(job.polarity.electrodeLead) +
        "</code><i>p." + job.polarity.page + "</i></div>" +
        // Only when the job is actually in range -- an example reading next to
        // "your metal is too thick for this process" reads like a recommendation.
        (job.onScreenExample && !below && !above
          ? "<div><b>Display example</b><code>" + esc(job.onScreenExample.reads) +
            "</code><i>p." + job.page + "</i></div>"
          : "") +
        "</div>";

      out.innerHTML =
        range +
        '<div class="steps" style="margin-top:12px">' + steps + "</div>" +
        derived +
        facts +
        (d.absence
          ? '<div class="wout" style="margin-top:12px"><span class="note">Why there is no ' +
            "lookup table: checked, not assumed — <code>" + esc(d.absence.probe) +
            "</code> appears <strong>" + d.absence.occurrencesInManual +
            " times</strong> across all 48 pages. CI asserts that on every build.</span></div>"
          : "");
    }
    update();
  }

  const BUILDERS = {
    duty_cycle_calculator: dutyCalculator,
    troubleshooting_flowchart: troubleshooting,
    settings_configurator: settingsConfigurator,
  };

  /** Build a widget card from a server payload. */
  window.widgetCard = function (p) {
    const el = document.createElement("div");
    el.className = "widget";
    el.innerHTML =
      '<div class="whd"><div><h4>' + esc(p.title) + "</h4>" +
      '<p class="sub">' + esc(p.subtitle) + "</p></div>" +
      (p.evidence === "mixed"
        ? '<span class="badge amber" title="Some values in this widget come from a document with no text layer, so they cannot be traced to a page of prose.">' +
          '<svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z"/>' +
          "</svg>Text + image</span>"
        : '<span class="badge"><svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M20 6L9 17l-5-5"/></svg>Verified</span>') +
      '</div><div class="wbody"></div>';
    const build = BUILDERS[p.kind];
    if (build) build(el.querySelector(".wbody"), p.data);
    return el;
  };
})();
