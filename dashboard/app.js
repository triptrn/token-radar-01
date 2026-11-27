// Token Radar's page, model radar-2, retold. It reads window.RADAR — the dataset
// main.ts wrote beside this page — and draws the ranked board, the filters,
// the per-protocol drawer and the model panel. Everything on screen comes from
// data.js; there is no fetch and no network.
(function () {
  'use strict';

  const DATA = window.RADAR;
  if (!DATA) return;
  const mount = document.getElementById('board');
  var view = { q: '', category: 'all', chain: 'all', watchlistOnly: false, tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var abs = Math.abs(n);
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `$${Math.round(n / 1e3)}K`;
    return moneyFmt.format(n);
  }

  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    var sign = n > 0 ? '+' : '';
    return `${sign}${n.toFixed(2)}%`;
  }

  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    var whole = Math.round(days);
    return `${whole < 0 ? 0 : whole}d`;
  }

  // The radar-2 model in one function: the page recomputes a row from the snapshot figures and checks
  // the number board.json carries, so the page's code and the board's data are visibly the same
  // arithmetic. Size compresses the value-per-TVL multiple as TVL grows; growth is clamped momentum;
  // maturity is age with no token on record; breadth is chain count, capped at six chains.
  function scoreRow(row, model) {
    var decades = Math.min(Math.max(Math.log10(Math.max(row.tvl_usd, 1) / model.size_ref_tvl), 0), model.size_log_cap);
    var size = model.size_high - model.size_step * decades;
    var change = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, change));
    var growth = 1 + (growthPct / 100) * model.growth_weight;
    var age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    var maturity = model.maturity_floor + (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    var breadth = 1 + model.breadth_per_chain * Math.min(Math.max((row.chains || []).length - 1, 0), model.breadth_max_extra);
    return Math.max(1, Math.round(row.tvl_usd * size * growth * maturity * breadth));
  }

  // A tiny DOM helper: h('div', { class: 'x', text: '…' }, child, [more]) — attrs map to
  // attributes, with class/text/html shortcuts and on* handlers; children may be strings,
  // nodes, or one level of arrays; nulls are skipped.
  function h(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var val = attrs[key];
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key === 'html') node.innerHTML = val;
        else if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), val);
        else if (val !== null && val !== undefined) node.setAttribute(key, val);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        child.forEach(function (c) { if (c) node.appendChild(c); });
      } else if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL and age
  // decide the action, the capital, the hold and every cost and time. No name is special-cased.
  function chainName(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function capitalFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDays(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  var PLAN_RULES = [
    { keys: ['lend', 'cdp', 'collateral'], make: function (capital, name, chain) { return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`; } },
    { keys: ['dex', 'yield', 'leveraged farm'], make: function (capital, name, chain) { return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`; } },
    { keys: ['bridge'], make: function (capital, name, chain) { return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`; } },
    { keys: ['staking', 'restak'], make: function (capital, name, chain) { return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`; } },
    { keys: ['perpetual', 'derivative'], make: function (capital, name, chain) { return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`; } },
    { keys: ['prediction'], make: function (capital, name, chain) { return `Fund $${capital} and place one market position on ${name}.`; } },
    { keys: ['curator', 'allocator'], make: function (capital, name, chain) { return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`; } },
    { keys: ['stable'], make: function (capital, name, chain) { return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`; } },
    { keys: ['rwa'], make: function (capital, name, chain) { return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`; } },
    { keys: ['insurance'], make: function (capital, name, chain) { return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`; } }
  ];
  function planAction(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    for (var i = 0; i < PLAN_RULES.length; i++) {
      var rule = PLAN_RULES[i];
      for (var j = 0; j < rule.keys.length; j++) {
        if (c.indexOf(rule.keys[j]) >= 0) return rule.make(capital, p.name, chain);
      }
    }
    return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
  }
  function stepLine(step) {
    var s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    if (s.length > 600) s = `${s.slice(0, 596)}...`;
    if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
    return s;
  }
  function planFor(p) {
    var chain = chainName(p);
    var capital = capitalFor(p);
    var hold = holdDays(p.age_days);
    return [
      { text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: planAction(p, capital, chain), cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
      { text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`, cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
      { text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`, cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`, cost: 'nothing but the log', time: '5 minutes' }
    ].map(stepLine);
  }

  // The hash carries the view: q (search), category, chain, w (watchlist only), p (open protocol).
  // The field order is the order the hash string is written in.
  var HASH_FIELDS = [
    { key: 'q', get: function () { return view.q; }, set: function (v) { view.q = v; } },
    { key: 'category', get: function () { return view.category === 'all' ? '' : view.category; }, set: function (v) { view.category = v; } },
    { key: 'chain', get: function () { return view.chain === 'all' ? '' : view.chain; }, set: function (v) { view.chain = v; } },
    { key: 'w', get: function () { return view.watchlistOnly ? '1' : ''; }, set: function (v) { if (v === '1') view.watchlistOnly = true; } },
    { key: 'p', get: function () { return view.selected; }, set: function (v) { view.selected = v; } },
  ];

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var params = new URLSearchParams(hash);
    HASH_FIELDS.forEach(function (field) {
      var value = params.get(field.key);
      if (value) field.set(value);
    });
  }
  function writeHash() {
    var params = new URLSearchParams();
    HASH_FIELDS.forEach(function (field) {
      var value = field.get();
      if (value) params.set(field.key, value);
    });
    var next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  // The watchlist is the TVL floor: every board row at or above it is a watchlist row, every row
  // below it is an early row the radar added. No rank test: a watchlist row may rank anywhere.
  function onWatchlist(row) {
    return row.tvl_usd >= DATA.floor_usd;
  }
  function visibleRows() {
    var q = view.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && (r.chains || []).indexOf(view.chain) < 0) return false;
      if (view.watchlistOnly && !onWatchlist(r)) return false;
      if (!q) return true;
      var parts = [r.name, r.slug, r.category, (r.chains || []).join(' ')];
      var hay = parts.map(function (p) { return (p || '').toLowerCase(); }).join(' ');
      return hay.indexOf(q) >= 0;
    });
  }
  function sortKey(r) {
    if (view.sort === 'name') return r.name.toLowerCase();
    if (view.sort === 'tvl') return r.tvl_usd;
    if (view.sort === 'growth') return r.change_7d === null ? -Infinity : r.change_7d;
    if (view.sort === 'age') return r.age_days === null ? Infinity : r.age_days;
    return r.implied_value_usd;
  }
  function orderedRows(list) {
    return list.slice().sort(function (a, b) {
      var av = sortKey(a);
      var bv = sortKey(b);
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }
  function medianValue() {
    var vals = DATA.rows.map(function (r) { return r.implied_value_usd; }).sort(function (a, b) { return a - b; });
    return vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  }

  function pageHeader() {
    return h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('span', { class: 'mark' }), h('span', { class: 'brand-name', text: 'Token Radar' })),
      h('div', { class: 'top-meta' },
        h('span', { text: 'Snapshot ' + DATA.as_of }),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function pageLede() {
    return h('section', { class: 'lede' },
      h('div', null,
        h('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', { text: `The watchlist is the floor: every protocol with at least $${Math.round(DATA.floor_usd / 1e6)}M of TVL and no token on record. The early radar adds ${DATA.early_size} pre-token protocols below that floor. Implied value is a model, not a promise.` })
      ),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('span', { text: 'Watchlist covered' }), h('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        h('div', { class: 'fact' }, h('span', { text: 'Pre-token rows scored' }), h('b', { text: String(DATA.board_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Early rows below the floor' }), h('b', { text: String(DATA.early_size) })),
        h('div', { class: 'fact' }, h('span', { text: 'Median implied value' }), h('b', { text: money(medianValue()) })),
        h('div', { class: 'fact' }, h('span', { text: 'Live-token protocols set aside' }), h('b', { text: String(DATA.live_size) }))
      )
    );
  }

  function pageControls() {
    var categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var chainCounts = new Map();
    DATA.rows.forEach(function (r) {
      (r.chains || []).forEach(function (c) {
        chainCounts.set(c, (chainCounts.get(c) || 0) + 1);
      });
    });
    var chains = Array.from(chainCounts.keys()).sort(function (a, b) { return chainCounts.get(b) - chainCounts.get(a); }).slice(0, 12);
    var search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { view.q = search.value; writeHash(); render(); });
    var select = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return h('option', { value: c, text: c, selected: c === view.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { view.category = select.value; writeHash(); render(); });
    var chainSelect = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return h('option', { value: c, text: c + ' (' + chainCounts.get(c) + ')', selected: c === view.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { view.chain = chainSelect.value; writeHash(); render(); });
    var wl = h('input', { type: 'checkbox', id: 'watchlist-only', checked: view.watchlistOnly ? 'checked' : null, 'aria-label': 'Watchlist only' });
    wl.addEventListener('change', function () { view.watchlistOnly = wl.checked; writeHash(); render(); });
    var pre = h('button', { type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { view.tab = 'pre-token'; render(); } });
    var live = h('button', { type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { view.tab = 'live'; render(); } });
    return h('div', { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), select),
      h('div', { class: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSelect),
      h('label', { class: 'check', for: 'watchlist-only' }, wl, h('span', { text: 'Watchlist only' })),
      h('div', { class: 'field' }, h('span', { class: 'sub', text: 'Token status' }), h('div', { class: 'tabs' }, pre, live)),
      h('span', { class: 'count', text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  function sortHead(key, label) {
    return h('th', { scope: 'col' },
      h('button', { type: 'button', onclick: function () { if (view.sort === key) view.dir = -view.dir; else { view.sort = key; view.dir = -1; } render(); } },
        label,
        view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function protocolCell(r) {
    var where = (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain');
    return h('div', { class: 'name' },
      h('b', { text: r.name }),
      h('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + where })
    );
  }

  function boardTable() {
    var list = orderedRows(visibleRows());
    if (list.length === 0) {
      return h('div', { class: 'panel' }, h('div', { class: 'empty' },
        h('h2', { text: 'No protocol matches that filter' }),
        h('p', { text: 'Clear the search or pick another category to see the board again.' }),
        h('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { view.q = ''; view.category = 'all'; view.chain = 'all'; view.watchlistOnly = false; writeHash(); render(); } })
      ));
    }
    var max = list[0].implied_value_usd || 1;
    var tbody = h('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      var growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var tr = h('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        h('td', { class: 'num', text: String(r.rank) }),
        h('td', null, protocolCell(r)),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + growthClass, text: growth }),
        h('td', { class: 'num', text: ageLabel(r.age_days) }),
        h('td', null, h('div', { class: 'implied' },
          h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          h('span', { class: 'num', text: money(r.implied_value_usd) })
        )),
        h('td', null, h('span', { class: 'status', text: 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null, h('tr', null,
            sortHead('implied', 'Rank'),
            sortHead('name', 'Protocol'),
            sortHead('tvl', 'TVL'),
            sortHead('growth', '7d'),
            sortHead('age', 'Age'),
            sortHead('implied', 'Implied value'),
            h('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    var tbody = h('tbody');
    DATA.live.forEach(function (r) {
      tbody.appendChild(h('tr', null,
        h('td', { class: 'num', text: 'live' }),
        h('td', null, protocolCell(r)),
        h('td', { class: 'num', text: money(r.tvl_usd) }),
        h('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
        h('td', { class: 'num', text: money(r.mcap_usd) }),
        h('td', null, h('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'table-wrap' },
        h('table', null,
          h('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Status' }), h('th', { scope: 'col', text: 'Protocol' }), h('th', { scope: 'col', text: 'TVL' }), h('th', { scope: 'col', text: '7d' }), h('th', { scope: 'col', text: 'Market cap' }), h('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    var m = DATA.model;
    var formula = `implied = round( tvl_usd x size x growth x maturity x breadth ), where size = ${m.size_high} - ${m.size_step} x clamp(log10(tvl_usd / ${m.size_ref_tvl}), 0, ${m.size_log_cap}), growth = 1 + clamp(change_7d, ${m.growth_floor}, ${m.growth_cap}) / 100 x ${m.growth_weight}, maturity = ${m.maturity_floor} + min(age_days, ${m.maturity_days}) / ${m.maturity_days} x ${m.maturity_range}, breadth = 1 + ${m.breadth_per_chain} x min(chains - 1, ${m.breadth_max_extra})`;
    return h('section', { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      h('div', { class: 'formula' }, formula),
      h('p', { class: 'sub', text: `TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ${m.unknown_age_days} days. Size compresses the value-per-TVL multiple as a protocol grows: 0.30 at $100M of TVL, 0.25 at $1B, 0.20 at $10B. Breadth counts the chains its TVL sits on, capped at six. The early radar is every pre-token protocol below the watchlist floor, by TVL, and the live-token protocols are set aside with their market caps shown.` })
    );
  }

  const dialog = h('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { view.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    view.selected = slug;
    writeHash();
    dialog.textContent = '';
    var steps = planFor(row);
    var recomputed = scoreRow(row, DATA.model);
    dialog.appendChild(h('div', { class: 'detail-head' },
      h('div', null,
        h('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        h('h2', { id: 'detail-title', text: row.name }),
        h('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      h('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Implied value' }),
      h('div', { class: 'equation' },
        h('div', null, h('span', { text: 'TVL' }), h('b', { class: 'num', text: money(row.tvl_usd) })),
        h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { class: 'num', text: pct(row.change_7d) })),
        h('div', null, h('span', { text: 'Age with no token' }), h('b', { class: 'num', text: ageLabel(row.age_days) })),
        h('div', null, h('span', { text: 'Chains' }), h('b', { class: 'num', text: String((row.chains || []).length) })),
        h('div', null, h('span', { text: 'Size multiple' }), h('b', { class: 'num', text: String(row.size_multiplier) })),
        h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { class: 'num', text: String(row.growth_multiplier) })),
        h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { class: 'num', text: String(row.maturity_multiplier) })),
        h('div', null, h('span', { text: 'Breadth multiplier' }), h('b', { class: 'num', text: String(row.breadth_multiplier) })),
        h('div', null, h('span', { text: 'Implied value' }), h('b', { class: 'num', text: money(row.implied_value_usd) }))
      ),
      h('p', { class: 'sub', text: `Model ${DATA.model_version}: the same function scores every protocol. The page recomputes this row as ${money(recomputed)}${recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.'} This is an estimate, not a price.` })
    ));
    dialog.appendChild(h('section', { class: 'detail-section' },
      h('h3', { text: 'Farm plan' }),
      h('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    mount.textContent = '';
    var shell = h('div', { class: 'shell' });
    shell.appendChild(pageHeader());
    shell.appendChild(pageLede());
    shell.appendChild(pageControls());
    shell.appendChild(view.tab === 'pre-token' ? boardTable() : liveTable());
    if (view.tab === 'pre-token') shell.appendChild(modelPanel());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
