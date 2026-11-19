// Launch Radar's page. It reads window.RADAR (written beside dashboard/ by main.ts) and renders the
// coverage strip, the model card with its out-of-sample validation, the sortable and filterable
// board, and a per-protocol detail drawer. No network: every byte it shows is in data.js.
// The drawer recomputes the row's implied value from the model constants and the snapshot figures,
// so the page's arithmetic and board.json's numbers are visibly the same arithmetic.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;
  var app = document.getElementById('board');
  var state = { q: '', category: 'all', chain: 'all', watchOnly: false, sort: 'rank', dir: 1, selected: null };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // The model, recomputed in the page from the same constants lib/model.ts fitted.
  function impliedOf(row, model) {
    var offset = model.category_offsets[row.category === null ? '(none)' : row.category] || 0;
    var raw = model.c0 + model.c1 * (Math.log(Math.max(1, row.tvl_usd)) - model.mean_log_tvl) + offset;
    var logRatio = Math.min(model.ratio_log_max, Math.max(model.ratio_log_min, raw));
    var base = Math.max(1, row.tvl_usd) * Math.exp(logRatio);
    var growth = 1;
    if (row.change_7d !== null && row.change_7d !== undefined) {
      var g = Math.min(model.growth_cap, Math.max(model.growth_floor, row.change_7d));
      growth = 1 + (g / 100) * model.growth_weight;
    }
    var days = row.age_days === null || row.age_days === undefined
      ? model.unknown_age_days
      : Math.min(Math.max(row.age_days, 0), model.maturity_days);
    var maturity = model.maturity_floor + (days / model.maturity_days) * model.maturity_range;
    return { implied: Math.max(1, Math.round(base * growth * maturity)), base: base, growth: growth, maturity: maturity };
  }

  // ---------- header and coverage ----------
  var cov = DATA.coverage;
  var hero = el('header', 'hero');
  hero.appendChild(el('div', 'kicker', 'Token launch radar · snapshot of ' + DATA.as_of));
  hero.appendChild(el('h1', null, 'Every pre-token protocol, ranked by what its token could be worth'));
  var intro = el('p');
  intro.appendChild(document.createTextNode('The snapshot records '));
  var strong = el('strong', null, cov.snapshot_protocols + ' protocols');
  intro.appendChild(strong);
  intro.appendChild(document.createTextNode('. ' + cov.tokenized + ' already record a token; the other ' +
    cov.pre_token + ' do not, and every one of them is ranked below by an implied value fitted from the ' +
    cov.comps_fitted + ' traded comparables among the tokenised — never from a hardcoded list. ' +
    'Each row carries the farm plan that goes with it.'));
  hero.appendChild(intro);
  app.appendChild(hero);

  var covCard = el('section', 'card');
  var covRow = el('div', 'coverage');
  [
    [cov.snapshot_protocols, 'protocols in the snapshot'],
    [cov.comps_fitted, 'traded comparables the curve is fitted on'],
    [cov.board_rows, 'pre-token protocols ranked — the whole board'],
    [cov.watchlist_covered + '/' + cov.watchlist, 'of the house watchlist covered (the floor, $' + (DATA.floor_usd / 1e6) + 'M TVL and up)'],
    [cov.pre_token - cov.board_rows === 0 ? '0' : String(cov.pre_token - cov.board_rows), 'pre-token protocols left unranked'],
  ].forEach(function (pair) {
    var stat = el('div', 'stat');
    var n = el('div', 'n');
    n.appendChild(el('em', null, String(pair[0])));
    stat.appendChild(n);
    stat.appendChild(el('div', 'l', pair[1]));
    covRow.appendChild(stat);
  });
  covCard.appendChild(covRow);
  app.appendChild(covCard);

  // ---------- model card ----------
  var v = DATA.validation;
  var model = DATA.model;
  function mult(err) { return '×' + Math.exp(err).toFixed(1); }
  var modelCard = el('section', 'card');
  modelCard.appendChild(el('h2', null, 'The value model, and how wrong it is'));
  var grid = el('div', 'model-grid');
  var left = el('div');
  left.appendChild(el('p', null, 'For each traded comparable, the snapshot gives a market cap and a TVL. Their ratio is ' +
    'fitted as a curve over log TVL — larger protocols trade at lower multiples — with one shift per category, ' +
    'shrunk toward zero when a category has few comparables. A pre-token protocol\'s implied value is its TVL on ' +
    'that curve, lifted by its 7-day TVL growth (bounded) and by how long it has run with no token.'));
  left.appendChild(el('p', null, 'The band on each row is the comparables\' own spread around the curve: half the ' +
    'rows should land inside it if the future behaves like the fitted past. The implied value is this radar\'s ' +
    'claim about worth if the protocol\'s record stayed as it is — not a prediction that a token will be issued.'));
  var offNames = Object.keys(model.category_offsets).sort(function (a, b) {
    return model.category_offsets[b] - model.category_offsets[a];
  });
  if (offNames.length) {
    var offText = offNames.slice(0, 3).map(function (c) { return c + ' ×' + Math.exp(model.category_offsets[c]).toFixed(2); })
      .concat(offNames.slice(-2).map(function (c) { return c + ' ×' + Math.exp(model.category_offsets[c]).toFixed(2); })).join(' · ');
    left.appendChild(el('p', null, 'Category shifts the curve reads: ' + offText + '.'));
  }
  grid.appendChild(left);
  var right = el('div');
  var vt = el('table', 'mini');
  var vhead = el('tr');
  ['Test (out of sample)', 'Typical miss', 'Within 2×'].forEach(function (h, i) {
    vhead.appendChild(el('th', i > 0 ? 'num' : null, h));
  });
  vt.appendChild(vhead);
  [
    ['Leave-one-out, this curve (' + v.comps + ' refits)', v.loo_median_abs_log_err, v.loo_within_2x],
    ['Leave-one-out, one flat ratio for all', v.naive_loo_median_abs_log_err, v.naive_loo_within_2x],
    ['Walk-forward: fit pre-2023, test ' + v.wf_test + ' later listings', v.wf_median_abs_log_err, v.wf_within_2x],
  ].forEach(function (r) {
    var tr = el('tr');
    tr.appendChild(el('td', null, r[0]));
    tr.appendChild(el('td', 'num', mult(r[1])));
    tr.appendChild(el('td', 'num', Math.round(r[2] * 100) + '%'));
    vt.appendChild(tr);
  });
  right.appendChild(vt);
  right.appendChild(el('p', null, 'No TVL-based radar pins a launch value; the honest claim is a centre, a band, ' +
    'and proof the centre is earned out of sample. These numbers are computed by the entry itself, from the snapshot, on every run.'));
  grid.appendChild(right);
  modelCard.appendChild(grid);
  app.appendChild(modelCard);

  // ---------- controls ----------
  var boardCard = el('section', 'card');
  var controls = el('div', 'controls');
  var search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search name or slug…';
  search.setAttribute('aria-label', 'Search protocols');
  search.addEventListener('input', function () { state.q = search.value.trim().toLowerCase(); renderTable(); });
  controls.appendChild(search);
  function selectFor(values, label, onChange) {
    var sel = document.createElement('select');
    sel.setAttribute('aria-label', label);
    var all = document.createElement('option');
    all.value = 'all';
    all.textContent = label + ': all';
    sel.appendChild(all);
    values.forEach(function (val) {
      var opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { onChange(sel.value); renderTable(); });
    return sel;
  }
  var categories = [];
  var chains = [];
  DATA.rows.forEach(function (r) {
    if (r.category && categories.indexOf(r.category) < 0) categories.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  categories.sort();
  chains.sort();
  controls.appendChild(selectFor(categories, 'Category', function (val) { state.category = val; }));
  controls.appendChild(selectFor(chains, 'Chain', function (val) { state.chain = val; }));
  var toggle = el('label', 'toggle');
  var box = document.createElement('input');
  box.type = 'checkbox';
  box.addEventListener('change', function () { state.watchOnly = box.checked; renderTable(); });
  toggle.appendChild(box);
  toggle.appendChild(document.createTextNode('Watchlist only'));
  controls.appendChild(toggle);
  var count = el('span', 'count');
  controls.appendChild(count);
  boardCard.appendChild(controls);

  var table = el('table', 'board');
  var thead = el('thead');
  var hrow = el('tr');
  var cols = [
    ['rank', '#', 'num'], ['name', 'Protocol', null], ['category', 'Category', null],
    ['tvl', 'TVL', 'num'], ['change', '7d', 'num'], ['age', 'Age', 'num'], ['implied', 'Implied value', 'num'],
  ];
  cols.forEach(function (c) {
    var th = el('th', c[2], c[1]);
    th.addEventListener('click', function () {
      if (state.sort === c[0]) state.dir = -state.dir;
      else { state.sort = c[0]; state.dir = c[0] === 'name' || c[0] === 'category' ? 1 : -1; }
      renderTable();
    });
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);
  var tbody = el('tbody');
  table.appendChild(tbody);
  boardCard.appendChild(table);
  app.appendChild(boardCard);

  function visibleRows() {
    var rows = DATA.rows.filter(function (r) {
      if (state.watchOnly && !r.watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.q && (r.name + ' ' + r.slug).toLowerCase().indexOf(state.q) < 0) return false;
      return true;
    });
    var key = {
      rank: function (r) { return r.rank; },
      name: function (r) { return r.name.toLowerCase(); },
      category: function (r) { return (r.category || '').toLowerCase(); },
      tvl: function (r) { return r.tvl_usd; },
      change: function (r) { return r.change_7d === null ? -Infinity : r.change_7d; },
      age: function (r) { return r.age_days === null ? -1 : r.age_days; },
      implied: function (r) { return r.implied_value_usd; },
    }[state.sort];
    rows.sort(function (a, b) {
      var ka = key(a);
      var kb = key(b);
      if (ka < kb) return -1 * state.dir;
      if (ka > kb) return 1 * state.dir;
      return a.rank - b.rank;
    });
    return rows;
  }

  function renderTable() {
    var rows = visibleRows();
    count.textContent = rows.length + ' of ' + DATA.rows.length + ' protocols · click a row for its detail and farm plan';
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', 'num', String(r.rank)));
      var nameTd = el('td');
      nameTd.appendChild(el('span', 'name', r.name));
      if (r.watchlist) {
        nameTd.appendChild(document.createTextNode(' '));
        nameTd.appendChild(el('span', 'watch', 'WATCHLIST'));
      }
      nameTd.appendChild(el('span', 'sub', ''));
      nameTd.lastChild.textContent = r.chains.slice(0, 3).join(' · ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '');
      tr.appendChild(nameTd);
      tr.appendChild(el('td', null, r.category || '—'));
      tr.appendChild(el('td', 'num', fmtUsd(r.tvl_usd)));
      var chTd = el('td', 'num' + (r.change_7d === null ? '' : r.change_7d >= 0 ? ' up' : ' down'), fmtPct(r.change_7d));
      tr.appendChild(chTd);
      tr.appendChild(el('td', 'num', fmtAge(r.age_days)));
      var impTd = el('td', 'num');
      impTd.appendChild(document.createTextNode(fmtUsd(r.implied_value_usd)));
      var band = el('span', 'band', fmtUsd(r.band_low_usd) + ' – ' + fmtUsd(r.band_high_usd));
      impTd.appendChild(band);
      tr.appendChild(impTd);
      tr.addEventListener('click', function () { openDrawer(r); });
      tbody.appendChild(tr);
    });
  }

  // ---------- detail drawer ----------
  var drawer = el('aside');
  drawer.id = 'drawer';
  drawer.hidden = true;
  document.body.appendChild(drawer);
  function closeDrawer() { drawer.hidden = true; state.selected = null; }
  function openDrawer(r) {
    state.selected = r.slug;
    while (drawer.firstChild) drawer.removeChild(drawer.firstChild);
    var close = el('button', 'close', 'Close');
    close.addEventListener('click', closeDrawer);
    drawer.appendChild(close);
    drawer.appendChild(el('h2', null, r.name));
    drawer.appendChild(el('div', 'meta',
      (r.category || 'Uncategorised') + ' · ' + r.chains.join(', ') + ' · rank #' + r.rank +
      (r.watchlist ? ' · on the house watchlist' : '')));
    var facts = el('table', 'mini');
    [
      ['TVL (snapshot)', fmtUsd(r.tvl_usd)],
      ['TVL change, 7 days', fmtPct(r.change_7d)],
      ['Tracked for', r.age_days === null ? 'unknown' : r.age_days + ' days'],
      ['Token', 'none recorded by DefiLlama as of ' + DATA.as_of],
    ].forEach(function (pair) {
      var tr = el('tr');
      tr.appendChild(el('td', null, pair[0]));
      tr.appendChild(el('td', 'num', pair[1]));
      facts.appendChild(tr);
    });
    drawer.appendChild(facts);
    drawer.appendChild(el('h3', null, 'How the implied value is built'));
    var chk = impliedOf(r, model);
    var parts = el('table', 'mini');
    [
      ['Curve base (TVL × fitted ratio)', fmtUsd(Math.round(chk.base))],
      ['× growth factor', '×' + chk.growth.toFixed(3)],
      ['× maturity factor', '×' + chk.maturity.toFixed(3)],
      ['Implied value', fmtUsd(r.implied_value_usd)],
      ['Comparables band', fmtUsd(r.band_low_usd) + ' – ' + fmtUsd(r.band_high_usd)],
    ].forEach(function (pair) {
      var tr = el('tr');
      tr.appendChild(el('td', null, pair[0]));
      tr.appendChild(el('td', 'num', pair[1]));
      parts.appendChild(tr);
    });
    drawer.appendChild(parts);
    drawer.appendChild(el('div', 'check',
      chk.implied === r.implied_value_usd
        ? '✓ This page recomputed the value from the snapshot figures and the model constants: it matches board.json.'
        : 'This page recomputed ' + fmtUsd(chk.implied) + ' — a mismatch with the board.'));
    drawer.appendChild(el('h3', null, 'Farm plan'));
    var plan = el('ol', 'plan');
    r.farm_steps.forEach(function (s) { plan.appendChild(el('li', null, s)); });
    drawer.appendChild(plan);
    drawer.hidden = false;
    drawer.scrollTop = 0;
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  var footer = el('footer');
  footer.appendChild(el('p', null, 'Source: ' + DATA.source + '. The watchlist is the house\'s floor — TVL at or above ' +
    fmtUsd(DATA.floor_usd) + ', no token recorded, not a wrapped or staked product of a traded token — and this board ' +
    'ranks every pre-token protocol in the snapshot, watchlist or not.'));
  footer.appendChild(el('p', null, 'A protocol here records no token in the snapshot; that is DefiLlama\'s record, not proof ' +
    'none exists. Implied values and farm costs are this radar\'s own estimates, stated so a reader can check them, ' +
    'and no step of a farm plan is financial advice.'));
  app.appendChild(footer);

  renderTable();
  app.setAttribute('aria-busy', 'false');
})();
