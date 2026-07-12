/* QTS Model Dashboard — vanilla JS + Plotly, no build step.
 *
 * Loads data/manifest.json, then each listed system's serving JSON
 * (signals / ledger / portfolio) and renders three views:
 *   Signals today — instruction table + portfolio tiles per system
 *   Equity curve  — model equity with the drawdown-ladder lines
 *   Paper ledger  — simulated fills
 *
 * DATA-DRIVEN: the page iterates manifest.systems and renders whatever
 * it finds — nothing here is specific to any instrument, so adding a
 * system (e.g. a gold leg) to the manifest needs no page change.
 * All fetches are RELATIVE so the page works under a Pages sub-path. */

(function () {
  'use strict';

  // ─── Palette (mirrors style.css) ─────────────────────────
  var C = {
    blue: '#1A6FFF', blueDark: '#1256CC',
    up: '#0E9F6E', down: '#E0264A', warn: '#F5A623',
    ink: '#0C1A30', text1: '#33415A', text2: '#5B6B83', text3: '#93A1B5',
    border: '#E4EAF3', surface: '#FFFFFF'
  };
  var LADDER_COLORS = ['#F5A623', '#EF7D3C', '#E0264A']; // mild → severe
  var FONT_SANS = "'Geist','SF Pro Display',system-ui,sans-serif";
  var FONT_MONO = "'JetBrains Mono',Consolas,monospace";
  // Regime quadrant palette (issue #14). Any label the JSON carries that
  // is not listed here falls back to a neutral swatch — the page stays
  // data-driven when a future regime model ships new state names.
  var REGIME_COLORS = {
    calm_uptrend: C.up,
    volatile_uptrend: C.warn,
    calm_downtrend: '#7A8CA8',
    volatile_downtrend: C.down
  };
  var REGIME_FALLBACK = '#B9C4D4';

  // ─── State ───────────────────────────────────────────────
  var state = { manifest: null, systems: [], regime: null, analysis: null, view: 'signals' };

  // ─── DOM refs ────────────────────────────────────────────
  var $panel = document.getElementById('panel');
  var $stats = document.getElementById('stats');
  var $nav = document.getElementById('nav');
  var $footUpdated = document.getElementById('foot-updated');
  var navButtons = Array.prototype.slice.call($nav.querySelectorAll('.nav-item'));

  // ─── Helpers ─────────────────────────────────────────────
  function fetchJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return r.json();
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function num(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    var d = digits === undefined ? 0 : digits;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function money(v, ccy) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return num(v, ccy === 'THB' ? 0 : 2);
  }
  function pct(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (100 * Number(v)).toFixed(digits === undefined ? 1 : digits) + '%';
  }

  // Ladder entries sorted mild → severe, e.g.
  // [{name:'halve_sizing',threshold:.1}, …] from portfolio.drawdown_ladder.
  function ladderEntries(ladder) {
    return Object.keys(ladder || {})
      .map(function (k) { return { name: k, threshold: ladder[k] }; })
      .sort(function (a, b) { return a.threshold - b.threshold; });
  }
  // Severity of a risk state within its ladder: -1 = normal.
  function severity(riskState, ladder) {
    return ladderEntries(ladder).map(function (e) { return e.name; }).indexOf(riskState);
  }
  function riskChip(riskState, ladder) {
    var sev = severity(riskState, ladder);
    var cls = sev < 0 ? 'normal' : (sev === 0 ? 'warn' : 'alert');
    return '<span class="risk-chip ' + cls + '">' + esc(String(riskState).replace(/_/g, ' ')) + '</span>';
  }
  function actionChip(action) {
    var cls = /^enter/.test(action) ? 'enter' : /^exit/.test(action) ? 'exit'
      : action === 'hold' ? 'hold' : 'none';
    return '<span class="action-chip ' + cls + '">' + esc(String(action).replace(/_/g, ' ')) + '</span>';
  }

  // ─── Boot ────────────────────────────────────────────────
  fetchJSON('./data/manifest.json').then(function (manifest) {
    state.manifest = manifest;
    // Regime artifact (issue #14) is optional: an older bundle without it
    // must render exactly as before.
    var regimeReq = manifest.regime
      ? fetchJSON('./data/' + manifest.regime.path).catch(function () { return null; })
      : Promise.resolve(null);
    // Narrative artifact (issue #18) is optional: it only exists once the
    // cloud routines have run, and the manifest never references it — so
    // fetch it blind and swallow the 404. Absent → quiet placeholders.
    var analysisReq = fetchJSON('./data/analysis.json').catch(function () { return null; });
    var systemsReq = Promise.all((manifest.systems || []).map(function (sys) {
      return Promise.all([
        fetchJSON('./data/' + sys.paths.signals),
        fetchJSON('./data/' + sys.paths.ledger),
        fetchJSON('./data/' + sys.paths.portfolio)
      ]).then(function (r) {
        return { meta: sys, signals: r[0], ledger: r[1], portfolio: r[2] };
      });
    }));
    return Promise.all([systemsReq, regimeReq, analysisReq]);
  }).then(function (loaded) {
    var systems = loaded[0];
    state.regime = loaded[1];
    state.analysis = loaded[2];
    state.systems = systems;
    $footUpdated.textContent = 'generated ' + (state.manifest.generated_at || '—');
    renderStats();
    setView(state.view);
  }).catch(function (err) {
    $panel.innerHTML = '';
    $panel.appendChild(el(
      '<div class="empty-state error-state"><h3>Could not load the dashboard data</h3><p>' +
      esc(err.message) + '</p></div>'));
  });

  // ─── Header stat strip (aggregate portfolio tile) ────────
  function renderStats() {
    var totalThb = 0, worst = null, asOf = '';
    state.systems.forEach(function (s) {
      var sum = s.portfolio.summary;
      totalThb += sum.final_equity_thb;
      if (sum.end_date > asOf) asOf = sum.end_date;
      if (worst === null ||
          severity(sum.risk_state, s.portfolio.drawdown_ladder) >
          severity(worst.summary.risk_state, worst.ladder) ||
          (severity(sum.risk_state, s.portfolio.drawdown_ladder) ===
           severity(worst.summary.risk_state, worst.ladder) &&
           sum.current_drawdown < worst.summary.current_drawdown)) {
        worst = { summary: sum, ladder: s.portfolio.drawdown_ladder };
      }
    });
    var cells = [
      { l: 'Model equity (THB)', v: num(totalThb, 0) + '<span class="unit">THB</span>' },
      { l: 'Systems', v: String(state.systems.length) },
      { l: 'Current drawdown', v: worst ? pct(worst.summary.current_drawdown) : '—' },
      { l: 'Risk state', v: worst ? riskChip(worst.summary.risk_state, worst.ladder) : '—' },
      { l: 'Marked', v: esc(asOf || '—') }
    ];
    // single-system convenience: native equity next to the THB total
    if (state.systems.length === 1) {
      var only = state.systems[0];
      cells.splice(1, 1, {
        l: 'Equity (' + esc(only.meta.native_currency) + ')',
        v: money(only.portfolio.summary.final_equity_usd, only.meta.native_currency)
      });
    }
    $stats.innerHTML = cells.map(function (c) {
      return '<div class="stat"><div class="sl">' + c.l + '</div><div class="sv num">' + c.v + '</div></div>';
    }).join('');
  }

  // ─── Views ───────────────────────────────────────────────
  function setView(view) {
    state.view = view;
    navButtons.forEach(function (b) {
      b.setAttribute('aria-current', b.getAttribute('data-view') === view ? 'true' : 'false');
    });
    $panel.innerHTML = '';
    if (!state.systems.length) {
      $panel.appendChild(el('<div class="empty-state"><h3>No systems</h3><p>The manifest lists no systems yet.</p></div>'));
      return;
    }
    if (view === 'signals') renderSignals();
    else if (view === 'brief') renderBrief();
    else if (view === 'weekly') renderWeekly();
    else if (view === 'equity') renderEquity();
    else renderLedger();
  }

  // ── Narrative layer (issue #18) ───────────────────────────
  // analysis.json is prose written by the cloud routines about the same
  // committed serving JSON this page already renders (ADR-0008: the LLM
  // narrates, it never computes a number). Absent or partial → quiet
  // placeholder; the dashboard must not break before the first run.
  function prose(text) {
    return String(text == null ? '' : text).trim().split(/\n\s*\n/).map(function (p) {
      return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }
  function narrativePlaceholder(title, what) {
    return el('<div class="empty-state"><h3>' + title + '</h3><p>' + what +
      ' It appears here automatically after the routine’s first run.</p></div>');
  }
  // Newest as_of across the systems' signals — the day the live bundle
  // describes. A brief older than this is shown but flagged as stale.
  function latestAsOf() {
    var latest = '';
    state.systems.forEach(function (s) {
      if (s.signals.as_of && s.signals.as_of > latest) latest = s.signals.as_of;
    });
    return latest;
  }
  // graceDays: how far the narrative may trail the live bundle before it
  // is flagged (0 for the daily brief; 7 for the weekly report, which is
  // naturally up to a week behind the daily signals).
  function staleNote(narrativeDate, label, graceDays) {
    var live = latestAsOf();
    if (!narrativeDate || !live) return '';
    var lagMs = new Date(live) - new Date(narrativeDate);
    if (isNaN(lagMs) || lagMs <= (graceDays || 0) * 86400000) return '';
    return '<div class="stale-note">' + label + ' is dated ' + esc(narrativeDate) +
      ', older than the latest signals (' + esc(live) + ') — the narrative routine has not caught up yet.</div>';
  }

  function renderBrief() {
    $panel.appendChild(el(
      '<div class="view-head"><div class="view-title">Morning brief</div>' +
      '<div class="view-sub">narrative layer — prose about the committed JSON, written after each signals run</div></div>'));
    var daily = state.analysis && state.analysis.daily;
    if (!daily) {
      $panel.appendChild(narrativePlaceholder('No morning brief yet',
        'The daily narrative routine writes a brief after each scheduled signals run (Tue–Sat mornings).'));
      return;
    }
    var labelBySid = {};
    state.systems.forEach(function (s) { labelBySid[s.meta.id] = s.meta; });

    var head = staleNote(daily.date, 'This brief', 0) +
      (daily.staleness ? '<div class="stale-note">' + esc(daily.staleness) + '</div>' : '');
    $panel.appendChild(el('<div class="card">' +
      '<div class="card-head"><div><div class="card-eyebrow">Daily narrative</div>' +
      '<div class="card-title">Morning brief · ' + esc(daily.date) + '</div></div>' +
      '<div class="card-sub num">written ' + esc(daily.generated_at) + '</div></div>' +
      head +
      '<div class="prose">' + prose(daily.brief) + '</div>' +
      '<div class="footnote">Narrative only — every number is quoted from the serving JSON, never recomputed. ' +
      'Signals are instructions for manual execution; nothing here places orders.</div>' +
      '</div>'));

    var rationale = Object.keys(daily.per_system || {}).map(function (sid) {
      var meta = labelBySid[sid];
      var title = meta ? meta.label : sid;
      var sub = meta ? meta.instrument + ' · ' + meta.family : '';
      return '<div class="rationale"><div class="rationale-head"><span class="rationale-title">' + esc(title) +
        '</span><span class="rationale-sub num">' + esc(sub) + '</span></div>' +
        '<div class="prose">' + prose(daily.per_system[sid]) + '</div></div>';
    }).join('');
    if (rationale) {
      $panel.appendChild(el('<div class="card">' +
        '<div class="card-head"><div><div class="card-eyebrow">Per system</div>' +
        '<div class="card-title">Signal rationale</div></div></div>' + rationale + '</div>'));
    }

    if (daily.regime_commentary) {
      $panel.appendChild(el('<div class="card">' +
        '<div class="card-head"><div><div class="card-eyebrow">Market regime</div>' +
        '<div class="card-title">Regime commentary</div></div></div>' +
        '<div class="prose">' + prose(daily.regime_commentary) + '</div>' +
        '<div class="footnote">Regime state is context — the strategies, not the quadrants, generate the signals.</div>' +
        '</div>'));
    }
  }

  function renderWeekly() {
    $panel.appendChild(el(
      '<div class="view-head"><div class="view-title">Weekly regime report</div>' +
      '<div class="view-sub">Saturday research narrative — the week’s regime moves and what they imply</div></div>'));
    var weekly = state.analysis && state.analysis.weekly;
    if (!weekly) {
      $panel.appendChild(narrativePlaceholder('No weekly report yet',
        'The weekly regime routine writes a research report on Saturday mornings.'));
      return;
    }
    $panel.appendChild(el('<div class="card">' +
      '<div class="card-head"><div><div class="card-eyebrow">Weekly report</div>' +
      '<div class="card-title">Week ending ' + esc(weekly.week_ending) + '</div></div>' +
      '<div class="card-sub num">written ' + esc(weekly.generated_at) + '</div></div>' +
      staleNote(weekly.week_ending, 'This report', 7) +
      '<div class="prose">' + prose(weekly.report) + '</div>' +
      '<div class="footnote">Narrative only — every number is quoted from the serving JSON, never recomputed. ' +
      'Paper signals for manual execution; nothing here places orders.</div>' +
      '</div>'));
    if (weekly.regime_moves) {
      $panel.appendChild(el('<div class="card">' +
        '<div class="card-head"><div><div class="card-eyebrow">Market regime</div>' +
        '<div class="card-title">Regime moves this week</div></div></div>' +
        '<div class="prose">' + prose(weekly.regime_moves) + '</div></div>'));
    }
    if (weekly.families_outlook) {
      $panel.appendChild(el('<div class="card">' +
        '<div class="card-head"><div><div class="card-eyebrow">Strategy families</div>' +
        '<div class="card-title">Families outlook</div></div></div>' +
        '<div class="prose">' + prose(weekly.families_outlook) + '</div>' +
        '<div class="footnote">Environmental context only — never a trade recommendation; family gating decisions ' +
        'belong to the human research process.</div>' +
        '</div>'));
    }
  }

  // ── Regime strip (issue #14) ──────────────────────────────
  function regimeColor(quadrant) {
    return REGIME_COLORS[quadrant] || REGIME_FALLBACK;
  }
  function regimeChip(current) {
    if (!current) {
      return '<span class="regime-chip"><span class="dot" style="background:' + REGIME_FALLBACK +
        '"></span>unclassified</span>';
    }
    return '<span class="regime-chip"><span class="dot" style="background:' + regimeColor(current.quadrant) +
      '"></span>' + esc(String(current.quadrant).replace(/_/g, ' ')) + '</span>';
  }
  // Run-length encode the [date, quadrant] history into strip segments.
  function regimeSegments(history) {
    var runs = [];
    history.forEach(function (entry) {
      var last = runs[runs.length - 1];
      if (last && last.quadrant === entry[1]) { last.n += 1; last.to = entry[0]; }
      else runs.push({ quadrant: entry[1], from: entry[0], to: entry[0], n: 1 });
    });
    return runs.map(function (r) {
      var label = String(r.quadrant).replace(/_/g, ' ') + ' · ' + r.from + ' → ' + r.to +
        ' (' + r.n + ' session' + (r.n === 1 ? '' : 's') + ')';
      return '<span class="seg" style="flex-grow:' + r.n + ';background:' + regimeColor(r.quadrant) +
        '" title="' + esc(label) + '"></span>';
    }).join('');
  }
  function renderRegimeCard() {
    var regime = state.regime;
    if (!regime || !(regime.legs || []).length) return;
    var rows = regime.legs.map(function (leg) {
      var strip = leg.history.length
        ? '<div class="regime-strip">' + regimeSegments(leg.history) + '</div>' +
          '<div class="regime-range num"><span>' + esc(leg.history[0][0]) + '</span><span>' +
          esc(leg.history[leg.history.length - 1][0]) + '</span></div>'
        : '<div class="regime-range">not enough history to classify yet (' + leg.n_bars + ' bars)</div>';
      return '<div class="regime-row">' +
        '<div class="regime-meta"><span class="regime-instrument">' + esc(leg.instrument) + '</span>' +
        regimeChip(leg.current) + '</div>' + strip + '</div>';
    }).join('');
    var quadrants = (regime.model && regime.model.quadrants) || Object.keys(REGIME_COLORS);
    var legend = quadrants.map(function (q) {
      return '<span class="key"><span class="sw" style="background:' + regimeColor(q) + '"></span>' +
        esc(String(q).replace(/_/g, ' ')) + '</span>';
    }).join('');
    var card = el('<div class="card">' +
      '<div class="card-head"><div><div class="card-eyebrow">Market regime</div>' +
      '<div class="card-title">Current quadrant per leg</div></div>' +
      '<div class="card-sub num">model ' + esc(regime.model.id) + ' v' + esc(regime.model.version) + '</div></div>' +
      rows +
      '<div class="regime-legend">' + legend + '</div>' +
      '<div class="footnote">Quadrant = 63-day realized-volatility percentile (vs its own history) × ' +
      'trend state (close vs 200-day average). Context only — signals are generated by the strategies, ' +
      'not by the regime.</div>' +
      '</div>');
    $panel.appendChild(card);
  }

  // ── Signals today ─────────────────────────────────────────
  function renderSignals() {
    $panel.appendChild(el(
      '<div class="view-head"><div class="view-title">Signals today</div>' +
      '<div class="view-sub">next-session instructions per system · paper only</div></div>'));

    renderRegimeCard();

    state.systems.forEach(function (s) {
      var sig = s.signals, sum = s.portfolio.summary;
      var lastDay = s.portfolio.days[s.portfolio.days.length - 1];
      var rows = (sig.instructions || []).map(function (inst) {
        var fill = inst.entry ? inst.entry.estimated_fill
          : inst.exit ? inst.exit.reference_price : null;
        var sizeTxt = inst.size_units === null
          ? (inst.exit && inst.exit.size_policy === 'close_all' ? 'close all' : '—')
          : num(inst.size_units);
        return '<tr>' +
          '<td>' + esc(inst.instrument) + '</td>' +
          '<td>' + actionChip(inst.action) + '</td>' +
          '<td>' + esc(inst.direction) + '</td>' +
          '<td class="num">' + sizeTxt + '</td>' +
          '<td class="num">' + money(fill, s.meta.native_currency) + '</td>' +
          '<td class="num">' + money(inst.notional_usd, s.meta.native_currency) + '</td>' +
          '<td class="num">' + money(inst.risk_thb, 'THB') + '</td>' +
          '<td class="num">' + esc(inst.valid_until) + '</td>' +
          '</tr>';
      }).join('');

      var sev = severity(sum.risk_state, s.portfolio.drawdown_ladder);
      var riskCls = sev < 0 ? '' : (sev === 0 ? ' flag' : ' alert');
      // Regime tag the signal was generated in (issue #14; absent on older payloads)
      var sigRegime = (sig.instructions && sig.instructions[0] && sig.instructions[0].regime) || null;
      var regimeSub = sigRegime ? ' · generated in ' + regimeChip(sigRegime) : '';
      var card = el('<div class="card">' +
        '<div class="card-head"><div><div class="card-eyebrow">' + esc(s.meta.label) + '</div>' +
        '<div class="card-title">' + esc(s.meta.instrument) + ' · ' + esc(s.meta.family) + '</div></div>' +
        '<div class="card-sub num">signal ' + esc(sig.signal_date) + ' · valid until ' + esc(sig.valid_until) + regimeSub + '</div></div>' +
        '<div class="tile-grid">' +
        tile('Equity (' + esc(s.meta.native_currency) + ')', money(sum.final_equity_usd, s.meta.native_currency), '') +
        tile('Equity (THB)', num(sum.final_equity_thb, 0), '') +
        tile('Drawdown', pct(sum.current_drawdown), '') +
        tile('Max drawdown', pct(sum.max_drawdown), '') +
        '<div class="bcell' + riskCls + '"><div class="bl">Risk state</div><div class="bv">' +
          riskChip(sum.risk_state, s.portfolio.drawdown_ladder) + '</div></div>' +
        tile('Position', num(lastDay.position_units), 'units') +
        '</div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th>Instrument</th><th>Action</th><th>Direction</th><th class="num">Size</th>' +
        '<th class="num">Est. fill</th><th class="num">Notional</th><th class="num">Risk (THB)</th>' +
        '<th class="num">Valid until</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="footnote">Fills are modeled at the next session’s open. THB figures convert at the ' +
        'latest USDTHB close for reporting only — FX is not a position.</div>' +
        '</div>');
      $panel.appendChild(card);
    });
  }
  function tile(label, value, unit) {
    return '<div class="bcell"><div class="bl">' + label + '</div><div class="bv">' + value +
      (unit ? '<small>' + unit + '</small>' : '') + '</div></div>';
  }

  // ── Equity curve + DD ladder ──────────────────────────────
  function renderEquity() {
    $panel.appendChild(el(
      '<div class="view-head"><div class="view-title">Model equity curve</div>' +
      '<div class="view-sub">native-currency equity vs running peak · drawdown-ladder lines</div></div>'));

    state.systems.forEach(function (s, i) {
      var days = s.portfolio.days;
      var dates = days.map(function (d) { return d.date; });
      var equity = days.map(function (d) { return d.equity_usd; });
      var equityThb = days.map(function (d) { return d.equity_thb; });
      var ccy = s.meta.native_currency;

      // running peak → ladder line = peak * (1 - threshold)
      var peak = [];
      equity.reduce(function (p, v, k) { p = Math.max(p, v); peak[k] = p; return p; }, -Infinity);

      var traces = [{
        x: dates, y: equity, customdata: equityThb,
        type: 'scatter', mode: 'lines', name: 'equity',
        line: { color: C.blue, width: 2 },
        hovertemplate: '%{x}<br>%{y:,.0f} ' + ccy + ' · %{customdata:,.0f} THB<extra>equity</extra>'
      }];
      ladderEntries(s.portfolio.drawdown_ladder).forEach(function (entry, k) {
        traces.push({
          x: dates,
          y: peak.map(function (p) { return p * (1 - entry.threshold); }),
          type: 'scatter', mode: 'lines',
          name: entry.name.replace(/_/g, ' ') + ' −' + Math.round(entry.threshold * 100) + '%',
          line: { color: LADDER_COLORS[k % LADDER_COLORS.length], width: 1.4, dash: 'dash' },
          hovertemplate: '%{x}<br>%{y:,.0f} ' + ccy + '<extra>' +
            esc(entry.name.replace(/_/g, ' ')) + ' −' + Math.round(entry.threshold * 100) + '%</extra>'
        });
      });
      // paper fills as markers on the curve
      var eqByDate = {};
      days.forEach(function (d) { eqByDate[d.date] = d.equity_usd; });
      ['buy', 'sell'].forEach(function (side) {
        var fills = (s.ledger.fills || []).filter(function (f) { return f.action === side; });
        if (!fills.length) return;
        traces.push({
          x: fills.map(function (f) { return f.date; }),
          y: fills.map(function (f) { return eqByDate[f.date]; }),
          type: 'scatter', mode: 'markers', name: side,
          marker: {
            symbol: side === 'buy' ? 'triangle-up' : 'triangle-down',
            size: 9, color: side === 'buy' ? C.up : C.down,
            line: { color: C.surface, width: 1 }
          },
          hovertemplate: '%{x}<br>' + side + ' %{text} units<extra>fill</extra>',
          text: fills.map(function (f) { return num(f.units); })
        });
      });

      var card = el('<div class="chart-card">' +
        '<div class="card-head"><div><div class="card-eyebrow">' + esc(s.meta.label) + '</div>' +
        '<div class="card-title">' + esc(s.meta.instrument) + ' · model equity (' + esc(ccy) + ')</div></div>' +
        '<div class="card-sub num">' + esc(s.portfolio.summary.start_date) + ' → ' +
        esc(s.portfolio.summary.end_date) + '</div></div>' +
        '<div class="plot" id="plot-' + i + '"></div>' +
        '<div class="chart-note">Ladder lines mark the drawdown thresholds against the running peak (' +
        esc(s.portfolio.ladder_basis) + '). Triangles are simulated paper fills.</div>' +
        '</div>');
      $panel.appendChild(card);

      Plotly.newPlot('plot-' + i, traces, {
        margin: { l: 64, r: 18, t: 12, b: 40 },
        font: { family: FONT_SANS, color: C.text1, size: 12 },
        paper_bgcolor: C.surface, plot_bgcolor: C.surface,
        xaxis: { gridcolor: C.border, linecolor: C.border, tickfont: { family: FONT_MONO, size: 11 } },
        yaxis: {
          gridcolor: C.border, linecolor: C.border, zeroline: false,
          tickfont: { family: FONT_MONO, size: 11 }, tickformat: ',.0f',
          title: { text: 'equity (' + ccy + ')', font: { size: 12 } }
        },
        legend: { orientation: 'h', y: -0.14, font: { size: 11.5 } },
        hovermode: 'x unified', showlegend: true
      }, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] });
    });
  }

  // ── Paper ledger ──────────────────────────────────────────
  function renderLedger() {
    $panel.appendChild(el(
      '<div class="view-head"><div class="view-title">Paper ledger</div>' +
      '<div class="view-sub">simulated fills — nothing here was executed anywhere</div></div>'));

    state.systems.forEach(function (s) {
      var ccy = s.meta.native_currency;
      var fills = (s.ledger.fills || []).slice().reverse();
      var rows = fills.map(function (f) {
        return '<tr>' +
          '<td class="num">' + esc(f.date) + '</td>' +
          '<td>' + actionChip(f.action === 'buy' ? 'enter_long' : 'exit_long') + '</td>' +
          '<td class="num">' + num(f.units) + '</td>' +
          '<td class="num">' + money(f.fill_price_usd, ccy) + '</td>' +
          '<td class="num">' + money(f.commission_usd, ccy) + '</td>' +
          '<td class="num">' + money(f.slippage_usd, ccy) + '</td>' +
          '<td class="num">' + money(f.cash_after_usd, ccy) + '</td>' +
          '</tr>';
      }).join('');
      var card = el('<div class="card">' +
        '<div class="card-head"><div><div class="card-eyebrow">' + esc(s.meta.label) + '</div>' +
        '<div class="card-title">' + esc(s.meta.instrument) + ' · ' + fills.length + ' fill(s)</div></div>' +
        '<div class="card-sub num">init cash ' + money(s.ledger.init_cash_usd, ccy) + ' ' + esc(ccy) + '</div></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
        '<th class="num">Date</th><th>Action</th><th class="num">Units</th><th class="num">Fill (' + esc(ccy) + ')</th>' +
        '<th class="num">Commission</th><th class="num">Slippage</th><th class="num">Cash after</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="footnote">' + esc(s.ledger.fill_doctrine) + '</div>' +
        '</div>');
      $panel.appendChild(card);
    });
  }

  // ─── Nav wiring (desktop + mobile drawer) ────────────────
  navButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      setView(b.getAttribute('data-view'));
      document.body.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      scrim.hidden = true;
    });
  });
  var toggle = document.getElementById('nav-toggle');
  var scrim = document.getElementById('scrim');
  toggle.addEventListener('click', function () {
    var open = document.body.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
  });
  scrim.addEventListener('click', function () {
    document.body.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
    scrim.hidden = true;
  });
})();
