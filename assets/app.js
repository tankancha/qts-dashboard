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

  // ─── State ───────────────────────────────────────────────
  var state = { manifest: null, systems: [], view: 'signals' };

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
    return Promise.all((manifest.systems || []).map(function (sys) {
      return Promise.all([
        fetchJSON('./data/' + sys.paths.signals),
        fetchJSON('./data/' + sys.paths.ledger),
        fetchJSON('./data/' + sys.paths.portfolio)
      ]).then(function (r) {
        return { meta: sys, signals: r[0], ledger: r[1], portfolio: r[2] };
      });
    }));
  }).then(function (systems) {
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
    else if (view === 'equity') renderEquity();
    else renderLedger();
  }

  // ── Signals today ─────────────────────────────────────────
  function renderSignals() {
    $panel.appendChild(el(
      '<div class="view-head"><div class="view-title">Signals today</div>' +
      '<div class="view-sub">next-session instructions per system · paper only</div></div>'));

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
      var card = el('<div class="card">' +
        '<div class="card-head"><div><div class="card-eyebrow">' + esc(s.meta.label) + '</div>' +
        '<div class="card-title">' + esc(s.meta.instrument) + ' · ' + esc(s.meta.family) + '</div></div>' +
        '<div class="card-sub num">signal ' + esc(sig.signal_date) + ' · valid until ' + esc(sig.valid_until) + '</div></div>' +
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
