'use strict';
(() => {
  // ---------- утилиты ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const money = (n) => `${nf.format(n || 0)} ₸`;
  const money0 = (n) => `${nf0.format(Math.round(n || 0))} ₸`;
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${nf.format(Math.abs(n))} ₸`;
  const pct = (x) => `${(x * 100).toFixed(1).replace('.', ',')}%`;

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => iso(new Date());
  const parse = (s) => new Date(`${s}T00:00:00`);
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
  const fmtDay = (s) => parse(s).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
  const fmtShort = (s) => parse(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const fmtMonth = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  const fmtDateTime = (t) => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };

  const PERIODS = [
    ['today', 'Сегодня'], ['week', 'Неделя'], ['month', 'Месяц'], ['lastMonth', 'Прошлый месяц'],
    ['year', 'Год'], ['all', 'Всё время'], ['custom', 'Свой'],
  ];
  function rangeFor(key, custom) {
    const t = today();
    const d = parse(t);
    switch (key) {
      case 'today': return { from: t, to: t };
      case 'week': { const wd = (d.getDay() + 6) % 7; return { from: addDays(t, -wd), to: t }; }
      case 'month': return { from: iso(new Date(d.getFullYear(), d.getMonth(), 1)), to: iso(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
      case 'lastMonth': return { from: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: iso(new Date(d.getFullYear(), d.getMonth(), 0)) };
      case 'year': return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` };
      case 'custom': return { from: custom.from || t, to: custom.to || t };
      default: return { from: null, to: null };
    }
  }

  const saleNet = (e) => e.amount - e.commission - e.delivery - e.packaging - e.label;
  const flow = (e) => (e.kind === 'sale' ? saleNet(e) : e.kind === 'topup' ? e.amount : -e.amount);
  const KIND_COLOR = { sale: 'var(--c-sale)', expense: 'var(--c-exp)', withdrawal: 'var(--c-wd)', topup: 'var(--c-top)' };

  // ---------- состояние ----------
  const state = {
    user: null, meta: null, view: 'overview',
    period: store.get('period', 'month'), custom: store.get('custom', {}),
    stats: null, entries: [], pending: [], review: 0, rev: 0, shown: 100,
    filters: { kind: '', channel: '', q: '' },
    charts: [], loading: false,
  };

  // ---------- API ----------
  async function api(path, opts = {}) {
    const res = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...opts,
      headers: { ...(opts.body && !(opts.body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      body: opts.body && !(opts.body instanceof ArrayBuffer) && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    let data = {};
    try { data = await res.json(); } catch { /* пустой ответ */ }
    if (res.status === 401 && path !== '/login') { state.user = null; renderLogin(); throw new Error('auth'); }
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- вход ----------
  function renderLogin(error = '') {
    destroyCharts();
    $('#app').innerHTML = `
      <div class="login"><form id="loginForm" autocomplete="on">
        <div><h1>Kaspi Учёт</h1><div class="muted">Поступления и расходы магазина</div></div>
        <label class="field"><span>Имя</span><input name="name" autocomplete="username" autocapitalize="words" required value="${esc(store.get('lastName', ''))}"></label>
        <label class="field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label>
        <div class="err" role="alert">${esc(error)}</div>
        <button class="btn" type="submit">Войти</button>
      </form></div>`;
    const f = $('#loginForm');
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = f.querySelector('button'); btn.disabled = true;
      try {
        const name = f.name.value.trim();
        store.set('lastName', name); // чтобы после ошибки пароля имя не пропадало
        await api('/login', { method: 'POST', body: { name, password: f.password.value } });
        await start();
      } catch (e) { renderLogin(e.message); }
    });
    (f.name.value ? f.password : f.name).focus();
  }

  // ---------- каркас ----------
  const ICONS = {
    overview: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    ops: '<path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    more: '<circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/>',
    add: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" fill="none" stroke-linecap="round"/>',
    auto: '<path d="M13 2L4 14h7l-1 8 9-12h-7z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

  function renderShell() {
    $('#app').innerHTML = `
      <header class="top">
        <div class="brand">Kaspi Учёт</div><div class="spacer"></div>
        <nav class="nav" aria-label="Разделы">
          <button data-view="overview">${icon('overview')}Обзор</button>
          <button data-view="ops">${icon('ops')}Операции</button>
          <button class="add" data-add aria-label="Добавить операцию">${icon('add')}<span class="lbl" hidden>Добавить</span></button>
          <button data-view="auto">${icon('auto')}Авто</button>
          <button data-view="more">${icon('more')}Ещё</button>
        </nav>
        <div class="who" title="Вы вошли как">${esc(state.user)}</div>
      </header>
      <main class="wrap" id="main"></main>`;
    document.querySelectorAll('.nav [data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    $('.nav [data-add]').addEventListener('click', () => openForm());
    const mq = matchMedia('(min-width: 900px)');
    const syncAdd = () => { $('.nav .lbl').hidden = !mq.matches; };
    mq.addEventListener('change', syncAdd); syncAdd();
  }

  function setView(v) {
    state.view = v;
    history.replaceState(null, '', `#${v}`);
    render();
  }

  function render({ keepScroll = false } = {}) {
    const y = window.scrollY;
    document.querySelectorAll('.nav [data-view]').forEach((b) => {
      if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    destroyCharts();
    const main = $('#main');
    if (!main) return;
    if (state.view === 'overview') renderOverview(main);
    else if (state.view === 'ops') renderOps(main);
    else if (state.view === 'auto') renderAuto(main);
    else renderMore(main);
    window.scrollTo(0, keepScroll ? y : 0); // смена вкладки — наверх, фоновое обновление — на месте
  }

  // ---------- загрузка данных ----------
  const query = () => {
    const r = rangeFor(state.period, state.custom);
    const p = new URLSearchParams();
    if (r.from) p.set('from', r.from);
    if (r.to) p.set('to', r.to);
    return p.toString();
  };

  async function load({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!silent && $('#main')) $('#main').innerHTML = '<div class="grid"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>';
    try {
      const q = query();
      const [stats, list, pend] = await Promise.all([api(`/stats?${q}`), api(`/entries?${q}`), api(`/pending?today=${today()}`)]);
      state.stats = stats; state.entries = list.entries; state.rev = Math.max(stats.rev, list.rev);
      state.pending = pend.pending; state.review = pend.review;
      state.shown = 100;
      // фоновое обновление не трогает экран «Авто» (там формы с вводом) и не сбрасывает прокрутку
      if (!silent) render();
      else if (!document.querySelector('dialog[open]') && state.view !== 'auto') render({ keepScroll: true });
    } catch (e) {
      if (e.message !== 'auth' && $('#main')) $('#main').innerHTML = `<div class="empty">Не удалось загрузить данные.<br>${esc(e.message)}<br><br><button class="btn" id="retry">Повторить</button></div>`;
      $('#retry')?.addEventListener('click', () => load());
    } finally { state.loading = false; }
  }

  function periodBar() {
    const r = rangeFor(state.period, state.custom);
    const label = r.from ? `${parse(r.from).toLocaleDateString('ru-RU')} — ${parse(r.to).toLocaleDateString('ru-RU')}` : 'за всё время';
    return `
      <div class="chips" role="group" aria-label="Период">
        ${PERIODS.map(([k, l]) => `<button class="chip" data-period="${k}" aria-pressed="${state.period === k}">${l}</button>`).join('')}
      </div>
      <div class="range"><span>${label}</span>
        ${state.period === 'custom' ? `<input type="date" id="cFrom" value="${esc(r.from)}" aria-label="С"> <input type="date" id="cTo" value="${esc(r.to)}" aria-label="По">` : ''}
      </div>`;
  }
  function bindPeriod() {
    document.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
      state.period = b.dataset.period; store.set('period', state.period); load();
    }));
    const apply = () => {
      const from = $('#cFrom').value; const to = $('#cTo').value;
      if (from && to && from <= to) { state.custom = { from, to }; store.set('custom', state.custom); load(); }
    };
    $('#cFrom')?.addEventListener('change', apply);
    $('#cTo')?.addEventListener('change', apply);
  }

  // ---------- обзор ----------
  function delta(cur, prev, inverse = false) {
    if (prev === null || prev === undefined || !prev) return '';
    const ch = (cur - prev) / Math.abs(prev);
    // при почти пустом прошлом периоде проценты вводят в заблуждение
    if (!Number.isFinite(ch) || Math.abs(ch) < 0.0005 || Math.abs(ch) > 9.99) return '';
    const good = inverse ? ch < 0 : ch > 0;
    return `<span class="delta ${good ? 'up' : 'down'}">${ch > 0 ? '▲' : '▼'} ${Math.abs(ch * 100).toFixed(0)}%</span>`;
  }

  function renderOverview(main) {
    const { stats } = state;
    if (!stats) return;
    const s = stats.summary; const p = stats.prev;
    const none = !state.entries.length;
    const vs = p ? 'к прошлому периоду' : '';
    const ch = s.byChannel;
    const total = ch.shop.revenue + ch.pay.revenue;

    main.innerHTML = `
      ${todoBlock()}
      ${periodBar()}
      <div class="grid kpis">
        <div class="card kpi"><div class="label">Выручка</div><div class="value num">${money0(s.revenue)}</div><div class="sub">${s.salesCount} продаж ${delta(s.revenue, p?.revenue)}</div></div>
        <div class="card kpi"><div class="label">Чистыми с продаж</div><div class="value num">${money0(s.netSales)}</div><div class="sub">после комиссий и доставки ${delta(s.netSales, p?.netSales)}</div></div>
        <div class="card kpi"><div class="label">Расходы</div><div class="value num">${money0(s.expenses)}</div><div class="sub">${vs} ${delta(s.expenses, p?.expenses, true)}</div></div>
        <div class="card kpi hero"><div class="label">Прибыль</div><div class="value num">${money0(s.profit)}</div><div class="sub">маржа ${pct(s.margin)} ${delta(s.profit, p?.profit)}</div></div>
      </div>
      <div class="grid kpis small">
        <div class="card kpi"><div class="label">Средний чек</div><div class="value num">${money0(s.avgCheck)}</div></div>
        <div class="card kpi"><div class="label">Комиссия Kaspi</div><div class="value num">${money0(s.commission)}</div><div class="sub">${pct(s.commissionRate)} выручки</div></div>
        <div class="card kpi"><div class="label">Доставка</div><div class="value num">${money0(s.delivery)}</div></div>
        <div class="card kpi"><div class="label">Снятия</div><div class="value num">${money0(s.withdrawals)}</div></div>
        <div class="card kpi"><div class="label">Пополнения</div><div class="value num">${money0(s.topups)}</div></div>
        <div class="card kpi"><div class="label">Остаток (расчётный)</div><div class="value num ${stats.balance < 0 ? 'neg' : ''}">${money0(stats.balance)}</div><div class="sub">за всё время</div></div>
      </div>
      ${none ? '<div class="card section empty">За этот период операций нет.<br>Нажмите «+», чтобы добавить первую.</div>' : `
      <div class="grid two section">
        <div class="card"><h2>${stats.granularity === 'month' ? 'По месяцам' : 'По дням'}</h2><div class="chart-box"><canvas id="chMain" role="img" aria-label="График выручки, расходов и прибыли"></canvas></div></div>
        <div class="grid">
          <div class="card"><h2>Каналы продаж</h2>
            ${total ? `<div class="bar2" aria-hidden="true"><span style="width:${ch.shop.revenue / total * 100}%;background:var(--c-sale)"></span><span style="width:${ch.pay.revenue / total * 100}%;background:var(--c-top)"></span></div>` : ''}
            <div class="legend">
              <div><span><i style="background:var(--c-sale)"></i>Kaspi Магазин · ${ch.shop.count}</span><b class="num">${money0(ch.shop.revenue)}</b></div>
              <div><span><i style="background:var(--c-top)"></i>Kaspi Pay · ${ch.pay.count}</span><b class="num">${money0(ch.pay.revenue)}</b></div>
            </div>
          </div>
          <div class="card"><h2>Расходы по категориям</h2>
            ${s.expenseByCategory.length ? `<div class="chart-box donut"><canvas id="chCat" role="img" aria-label="Расходы по категориям"></canvas></div>
              <div class="legend" style="margin-top:10px">${s.expenseByCategory.map((c, i) => `<div><span><i style="background:${palette(i)}"></i>${esc(c.category)}</span><b class="num">${money0(c.total)}</b></div>`).join('')}</div>`
              : '<div class="muted">Расходов нет</div>'}
          </div>
        </div>
      </div>
      ${stats.months.length > 1 ? `
      <div class="card section"><h2>Помесячно</h2><div class="scroll-x"><table>
        <thead><tr><th>Месяц</th><th>Выручка</th><th>Чистыми</th><th>Расходы</th><th>Прибыль</th></tr></thead>
        <tbody>${stats.months.map((m) => `<tr><td style="text-transform:capitalize">${fmtMonth(m.key)}</td><td class="num">${money0(m.revenue)}</td><td class="num">${money0(m.netSales)}</td><td class="num">${money0(m.expenses)}</td><td class="num ${m.profit < 0 ? 'neg' : 'pos'}">${money0(m.profit)}</td></tr>`).join('')}</tbody>
      </table></div></div>` : ''}`}`;
    bindPeriod();
    bindTodo();
    if (!none) drawCharts();
  }

  // «К внесению»: регулярные платежи этого месяца и продажи с приблизительными удержаниями
  function todoBlock() {
    const items = state.pending.filter((p) => p.status !== 'later');
    const later = state.pending.filter((p) => p.status === 'later');
    if (!items.length && !later.length && !state.review) return '';
    const row = (p) => `<div class="todo ${p.status}">
        <div><b>${esc(p.category)}</b> · <span class="num">${money(p.amount)}</span>
          <div class="muted" style="font-size:13px">${p.status === 'overdue' ? `просрочено на ${-p.daysLeft} дн.` : p.daysLeft === 0 ? 'сегодня' : `через ${p.daysLeft} дн.`} · ${parse(p.dueDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</div></div>
        <button class="btn small" data-confirm="${p.id}" data-month="${p.key.split(':')[1]}">Внесено</button></div>`;
    return `<div class="card section" style="margin:0 0 12px"><h2>К внесению</h2>
      ${items.map(row).join('')}
      ${later.length ? `<details><summary class="muted" style="cursor:pointer;padding:6px 0">Позже в этом месяце: ${later.length}</summary>${later.map(row).join('')}</details>` : ''}
      ${state.review ? `<div class="todo review"><div><b>${state.review}</b> продаж с приблизительной комиссией/доставкой<div class="muted" style="font-size:13px">Сверьте с выплатой Kaspi — это одна цифра</div></div><button class="btn small ghost" data-goto="auto">Сверить</button></div>` : ''}
    </div>`;
  }
  function bindTodo() {
    document.querySelectorAll('[data-confirm]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { await api('/pending/confirm', { method: 'POST', body: { id: Number(b.dataset.confirm), month: b.dataset.month } }); toast('Внесено'); await load({ silent: true }); }
      catch (e) { toast(e.message); b.disabled = false; }
    }));
    document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.goto)));
  }

  const PALETTE = ['#0f9d84', '#d9534f', '#2f80c9', '#e0a23a', '#8a63d2', '#6b7f78', '#d46aa5', '#4aa3a8'];
  const palette = (i) => PALETTE[i % PALETTE.length];
  function destroyCharts() { state.charts.forEach((c) => c.destroy()); state.charts = []; }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

  function drawCharts() {
    if (typeof Chart === 'undefined') return;
    const { stats } = state; const s = stats.summary;
    const text = cssVar('--muted'); const line = cssVar('--line');
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    Chart.defaults.color = text;
    const labels = stats.series.map((x) => (stats.granularity === 'month' ? fmtMonth(x.key).replace(/ г\.?$/, '') : fmtShort(x.key)));

    state.charts.push(new Chart($('#chMain'), {
      data: {
        labels,
        datasets: [
          { type: 'bar', label: 'Выручка', data: stats.series.map((x) => x.revenue), backgroundColor: cssVar('--c-sale'), borderRadius: 4, order: 2 },
          { type: 'bar', label: 'Расходы', data: stats.series.map((x) => x.expenses), backgroundColor: cssVar('--c-exp'), borderRadius: 4, order: 2 },
          { type: 'line', label: 'Прибыль', data: stats.series.map((x) => x.profit), borderColor: cssVar('--c-top'), backgroundColor: cssVar('--c-top'), tension: 0, pointRadius: 2, order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } }, tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` } } },
        scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } }, y: { grid: { color: line }, ticks: { callback: (v) => nf0.format(v) } } },
      },
    }));

    if ($('#chCat')) {
      state.charts.push(new Chart($('#chCat'), {
        type: 'doughnut',
        data: { labels: s.expenseByCategory.map((c) => c.category), datasets: [{ data: s.expenseByCategory.map((c) => c.total), backgroundColor: s.expenseByCategory.map((_, i) => palette(i)), borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${money(c.parsed)}` } } } },
      }));
    }
  }

  // ---------- операции ----------
  function renderOps(main) {
    main.innerHTML = `
      ${periodBar()}
      <div class="toolbar">
        <input class="search" id="q" type="search" placeholder="Поиск: категория, комментарий, сумма" value="${esc(state.filters.q)}" aria-label="Поиск">
        <div class="chips" role="group" aria-label="Фильтр">
          ${[['', 'Все'], ['sale', 'Продажи'], ['expense', 'Расходы'], ['withdrawal', 'Снятия'], ['topup', 'Пополнения']]
            .map(([k, l]) => `<button class="chip" data-kind="${k}" aria-pressed="${state.filters.kind === k}">${l}</button>`).join('')}
          ${[['shop', 'Магазин'], ['pay', 'Pay']].map(([k, l]) => `<button class="chip" data-channel="${k}" aria-pressed="${state.filters.channel === k}">${l}</button>`).join('')}
        </div>
      </div>
      <div id="listBox"></div>`;
    bindPeriod();
    $('#q').addEventListener('input', (e) => { state.filters.q = e.target.value; state.shown = 100; drawList(); });
    document.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { state.filters.kind = b.dataset.kind; renderOps(main); }));
    document.querySelectorAll('[data-channel]').forEach((b) => b.addEventListener('click', () => {
      state.filters.channel = state.filters.channel === b.dataset.channel ? '' : b.dataset.channel; renderOps(main);
    }));
    drawList();
  }

  function drawList() {
    const f = state.filters; const needle = f.q.trim().toLowerCase();
    const items = state.entries.filter((e) =>
      (!f.kind || e.kind === f.kind) && (!f.channel || e.channel === f.channel) &&
      (!needle || `${e.category} ${e.note} ${e.amount} ${e.created_by}`.toLowerCase().includes(needle)));
    const box = $('#listBox');
    if (!items.length) { box.innerHTML = '<div class="empty">Ничего не найдено</div>'; return; }

    const page = items.slice(0, state.shown);
    const groups = [];
    for (const e of page) {
      const g = groups[groups.length - 1];
      if (g && g.date === e.date) g.items.push(e); else groups.push({ date: e.date, items: [e] });
    }
    box.innerHTML = groups.map((g) => {
      const sum = g.items.reduce((a, e) => a + flow(e), 0);
      return `<div class="day"><span>${fmtDay(g.date)}</span><span class="num ${sum < 0 ? 'neg' : 'pos'}">${signed(sum)}</span></div>
        <div class="list">${g.items.map(rowHtml).join('')}</div>`;
    }).join('') + (items.length > page.length ? `<div style="text-align:center;margin-top:14px"><button class="btn ghost" id="more">Показать ещё (${items.length - page.length})</button></div>` : '');
    box.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => openForm(state.entries.find((e) => e.id === Number(b.dataset.id)))));
    $('#more')?.addEventListener('click', () => { state.shown += 100; drawList(); });
  }

  function rowHtml(e) {
    const title = e.kind === 'sale' ? `Продажа · ${e.channel === 'pay' ? 'Kaspi Pay' : 'Магазин'}` : (e.category || state.meta.kinds[e.kind]);
    const sub = [e.kind === 'sale' ? e.category : '', e.note, e.source === 'kaspi' ? '' : e.created_by].filter(Boolean).join(' · ');
    const amt = flow(e);
    const ded = e.kind === 'sale' ? e.commission + e.delivery + e.packaging + e.label : 0;
    return `<button class="row" data-id="${e.id}">
      <span class="dot" style="background:${KIND_COLOR[e.kind]}"></span>
      <span><div class="t">${esc(title)}${e.source === 'kaspi' ? ' <span class="tag">авто</span>' : e.source === 'recurring' ? ' <span class="tag">регулярный</span>' : ''}</div><div class="s">${esc(sub)}</div></span>
      <span class="a num ${amt < 0 ? 'neg' : 'pos'}">${e.kind === 'sale' ? '+' + money(e.amount) : signed(amt)}${ded ? `<small>${e.estimated ? '≈ ' : ''}чистыми ${money(amt)}</small>` : ''}</span>
    </button>`;
  }

  // ---------- форма ----------
  function openForm(entry) {
    const editing = !!(entry && entry.id); // объект без id — это «новая операция по образцу»
    const e = entry || { kind: 'sale', channel: store.get('lastChannel', 'shop'), date: today(), amount: '', commission: '', delivery: '', packaging: '', label: '', category: '', note: '' };
    const dlg = $('#sheet');
    const v = (n) => (e[n] === 0 || e[n] === '' || e[n] == null ? '' : e[n]);

    dlg.innerHTML = `
      <form class="sheet" id="entryForm" novalidate>
        <h2><span>${editing ? 'Изменить операцию' : 'Новая операция'}</span><button type="button" class="x" aria-label="Закрыть" data-close>×</button></h2>
        <div class="seg" role="radiogroup" aria-label="Тип операции">
          ${Object.entries(state.meta.kinds).map(([k, l]) => `<label><input type="radio" name="kind" value="${k}" ${e.kind === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        </div>
        <div class="seg" role="radiogroup" aria-label="Канал" id="chBox">
          ${Object.entries(state.meta.channels).map(([k, l]) => `<label><input type="radio" name="channel" value="${k}" ${(e.channel || 'shop') === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}
        </div>
        <div class="two-col">
          <label class="field"><span id="amtLbl">Сумма</span><input class="big" name="amount" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(v('amount'))}" required></label>
          <label class="field"><span>Дата</span><input type="date" name="date" value="${esc(e.date)}" required></label>
        </div>
        <div id="dedBox" class="stack">
          <div class="two-col">
            <label class="field"><span>Комиссия Kaspi</span><input name="commission" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(v('commission'))}"></label>
            <label class="field"><span>Доставка</span><input name="delivery" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(v('delivery'))}"></label>
            <label class="field"><span>Пакет</span><input name="packaging" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(v('packaging'))}"></label>
            <label class="field"><span>Этикетка</span><input name="label" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(v('label'))}"></label>
          </div>
          <div class="hint" id="netHint"></div>
        </div>
        <label class="field"><span>Категория</span><input name="category" list="catList" autocomplete="off" maxlength="60" value="${esc(e.category)}"></label>
        <datalist id="catList"></datalist>
        <div class="cats" id="catChips"></div>
        <label class="field"><span>Комментарий</span><input name="note" autocomplete="off" maxlength="300" value="${esc(e.note)}"></label>
        <div class="err" id="formErr" role="alert"></div>
        <div class="btns">
          <button class="btn" type="submit" data-act="save">Сохранить</button>
          ${editing ? '' : '<button class="btn ghost" type="submit" data-act="again">Сохранить и добавить ещё</button>'}
          ${editing ? `<button class="btn ghost" type="button" id="dup">Повторить с сегодняшней датой</button><button class="btn danger" type="button" id="del">Удалить операцию</button><div class="muted" style="font-size:12px;text-align:center">Внёс: ${esc(e.created_by)} · ${fmtDateTime(e.created_at)}${e.updated_by !== e.created_by || e.updated_at !== e.created_at ? ` · изменил: ${esc(e.updated_by)} ${fmtDateTime(e.updated_at)}` : ''}</div>` : ''}
        </div>
      </form>`;
    const f = $('#entryForm');
    let est = !!e.estimated && (Number(e.commission) > 0 || Number(e.delivery) > 0); // значения подобраны автоматически и не правились вручную
    let userTouched = editing;
    const kind = () => f.kind.value;
    const num = (n) => Number(String(f[n].value).replace(/\s/g, '').replace(',', '.')) || 0;

    const sync = () => {
      const k = kind();
      $('#chBox').hidden = k !== 'sale';
      $('#dedBox').hidden = k !== 'sale';
      $('#amtLbl').textContent = { sale: 'Сумма продажи', expense: 'Сумма расхода', withdrawal: 'Сумма снятия', topup: 'Сумма пополнения' }[k];
      const cats = state.meta.categories[k] || [];
      $('#catList').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('');
      $('#catChips').innerHTML = cats.map((c) => `<button type="button" class="chip" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
      f.category.closest('label').hidden = k === 'sale' && !f.category.value;
      hint();
    };
    const hint = () => {
      if (kind() !== 'sale') return;
      const a = num('amount'); const ded = num('commission') + num('delivery') + num('packaging') + num('label');
      $('#netHint').innerHTML = a ? `Чистыми: <b class="num">${money(a - ded)}</b>${num('commission') ? ` · комиссия ${pct(num('commission') / a)}` : ''}${est ? `<br>≈ подобрано автоматически (${sugNote || 'ранее'}). Поправьте, если знаете точно — иначе сверьте с выплатой Kaspi.` : ''}` : 'Введите сумму — комиссию и доставку подберу по вашей истории';
    };
    f.addEventListener('input', (ev) => {
      if (['commission', 'delivery', 'packaging', 'label'].includes(ev.target.name) && ev.isTrusted) { userTouched = true; est = false; }
      if (ev.target.name === 'amount' || ev.target.name === 'category') suggestSoon();
      hint();
    });
    f.querySelectorAll('[name=channel]').forEach((r) => r.addEventListener('change', suggestSoon));
    let timer; let sugNote = ''; let inflight = null;
    async function suggestNow() {
      if (kind() !== 'sale' || userTouched || !num('amount')) return;
      const asked = `${num('amount')}|${f.channel.value}|${f.category.value}`;
      try {
        const { suggestion: s } = await api(`/suggest?amount=${num('amount')}&channel=${f.channel.value}&category=${encodeURIComponent(f.category.value)}`);
        const now = `${num('amount')}|${f.channel.value}|${f.category.value}`;
        if (!s || userTouched || asked !== now) return; // ввод уже изменился — ответ устарел
        f.commission.value = s.commission || ''; f.delivery.value = s.delivery || '';
        est = (s.commission || 0) + (s.delivery || 0) > 0;
        sugNote = s.basis === 'rate' ? 'по ставке категории' : `по ${s.samples} похожим продажам из вашей истории`;
        hint();
      } catch { /* подсказка необязательна */ }
    }
    function suggestSoon() {
      clearTimeout(timer);
      timer = setTimeout(() => { inflight = suggestNow(); }, 250);
    }
    f.querySelectorAll('[name=kind]').forEach((r) => r.addEventListener('change', sync));
    $('#catChips').addEventListener('click', (ev) => { const b = ev.target.closest('[data-cat]'); if (b) { f.category.value = b.dataset.cat; } });
    dlg.querySelector('[data-close]').addEventListener('click', () => dlg.close());
    dlg.onclick = (ev) => { if (ev.target === dlg) dlg.close(); };
    sync(); // у продаж поле «Категория» необязательно и скрыто, пока пусто

    let again = false;
    f.querySelectorAll('[type=submit]').forEach((b) => b.addEventListener('click', () => { again = b.dataset.act === 'again'; }));
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = {
        kind: kind(), channel: kind() === 'sale' ? f.channel.value : null, date: f.date.value,
        amount: f.amount.value, commission: f.commission.value, delivery: f.delivery.value,
        packaging: f.packaging.value, label: f.label.value, category: f.category.value, note: f.note.value,
        estimated: kind() === 'sale' && est,
      };
      const btns = f.querySelectorAll('button'); btns.forEach((b) => { b.disabled = true; });
      try {
        // не сохраняем продажу с пустыми удержаниями, пока подсказка ещё в пути
        clearTimeout(timer);
        if (inflight) await inflight;
        if (kind() === 'sale' && !userTouched && !num('commission') && !num('delivery')) await suggestNow();
        body.commission = f.commission.value; body.delivery = f.delivery.value; body.estimated = kind() === 'sale' && est;
        await api(editing ? `/entries/${e.id}` : '/entries', { method: editing ? 'PUT' : 'POST', body });
        if (body.channel) store.set('lastChannel', body.channel);
        toast(editing ? 'Изменения сохранены' : 'Операция добавлена');
        if (again) { dlg.close(); await load({ silent: true }); openForm({ ...body, amount: '', commission: '', delivery: '', packaging: '', label: '', note: '', category: body.kind === 'sale' ? '' : body.category }); return; }
        dlg.close(); await load({ silent: true });
      } catch (err) {
        if (err.message !== 'auth') { $('#formErr').textContent = err.message; btns.forEach((b) => { b.disabled = false; }); }
      }
    });
    $('#dup')?.addEventListener('click', () => {
      dlg.close();
      openForm({ kind: e.kind, channel: e.channel, date: today(), amount: e.amount, commission: e.commission, delivery: e.delivery, packaging: e.packaging, label: e.label, category: e.category, note: '', estimated: e.estimated });
    });
    $('#del')?.addEventListener('click', async () => {
      if (!confirm('Удалить эту операцию? Это действие запишется в журнал.')) return;
      try { await api(`/entries/${e.id}`, { method: 'DELETE' }); toast('Удалено'); dlg.close(); await load({ silent: true }); }
      catch (err) { $('#formErr').textContent = err.message; }
    });
    dlg.showModal();
    if (!editing) f.amount.focus();
  }

  // ---------- «Авто»: синхронизация, ставки, регулярные платежи, сверка ----------
  async function renderAuto(main, kaspiMsg = '') {
    const y = window.scrollY;
    if (!main.querySelector('.stack')) main.innerHTML = '<div class="grid"><div class="skeleton"></div><div class="skeleton"></div></div>';
    let kaspi; let rates; let rec;
    try { [kaspi, rates, rec] = await Promise.all([api('/kaspi/status'), api('/rates'), api('/recurring')]); }
    catch (e) { if (e.message !== 'auth') main.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }

    const last = kaspi.last;
    const lastLine = !last ? 'Ещё не запускалась'
      : last.ok ? `Последняя синхронизация: ${fmtDateTime(last.at)} · новых продаж: ${last.added}`
        : `<span class="neg">Ошибка (${fmtDateTime(last.at)}): ${esc(last.message)}</span>`;
    const month = rangeFor('month');

    main.innerHTML = `<div class="stack" style="max-width:720px;margin:0 auto">
      <div class="card stack">
        <h2>Kaspi Магазин: продажи вносятся сами</h2>
        ${kaspi.configured ? `
          <div>${lastLine}</div>
          <div class="muted" style="font-size:13px">Сервер сам проверяет заказы раз в 30 минут и вносит только завершённые. Комиссия считается по ставкам ниже, а там, где ставки нет, подбирается по вашей истории. Такие продажи помечены «≈», пока вы не сверите их с выплатой.</div>
          <div class="btns"><button class="btn ghost" id="kTest">Проверить без записи</button><button class="btn" id="kSync">Синхронизировать сейчас</button></div>
          <div id="kOut" class="muted"></div>`
        : `<div class="muted">Не подключено. Нужен токен продавца Kaspi Магазина: как его получить, описано в справке Kaspi («Как получить токен авторизации в Магазине на Kaspi.kz?» в разделе API на guide.kaspi.kz). Затем задайте его на сервере в переменной <b>KASPI_TOKEN</b> и перезапустите — здесь появятся кнопки.</div>
           <div class="muted" style="font-size:13px">Kaspi Pay публичного API для выписки не даёт — для него остаются ввод с подсказками и сверка ниже.</div>`}
      </div>

      <div class="card stack">
        <h2>Ставки комиссии по категориям</h2>
        <div class="muted" style="font-size:13px">Комиссию задаёт Kaspi для каждой категории товара — приложение само ничего не «узнаёт». Укажите ставку один раз (так, как она выходит в вашем отчёте Kaspi, с НДС, если он у вас удерживается), и продажи этой категории считаются автоматически.</div>
        ${rates.rates.length ? `<table><tbody>${rates.rates.map((r) => `<tr><td>${esc(r.category)}</td><td class="num">${nf.format(r.percent)}%</td><td><button class="chip" data-rate-del="${esc(r.category)}" aria-label="Удалить ставку ${esc(r.category)}">×</button></td></tr>`).join('')}</tbody></table>` : '<div class="muted">Ставок пока нет.</div>'}
        ${rates.unknown.length ? `<div class="hint">Новые категории из заказов — задайте ставку:<div class="cats" style="margin-top:6px">${rates.unknown.map((u) => `<button class="chip" data-rate-pick="${esc(u.category)}">${esc(u.category)} · ${u.count}</button>`).join('')}</div></div>` : ''}
        <form id="rateForm" class="two-col"><label class="field"><span>Категория (как в Kaspi)</span><input name="category" required maxlength="80"></label>
          <label class="field"><span>Ставка, %</span><input name="percent" inputmode="decimal" required placeholder="12,5"></label>
          <button class="btn" type="submit" style="grid-column:1/-1">Сохранить ставку</button></form>
        <button class="btn ghost" id="recalc">Пересчитать приблизительные продажи по ставкам</button>
        <div class="err" id="rateErr"></div>
      </div>

      <div class="card stack">
        <h2>Регулярные платежи</h2>
        <div class="muted" style="font-size:13px">Налог, соцотчисления, абонентская плата: на главной появится «К внесению», вносится одним нажатием.</div>
        ${rec.recurring.length ? `<table><tbody>${rec.recurring.map((r) => `<tr style="${r.active ? '' : 'opacity:.5'}"><td>${esc(r.category)}<div class="muted" style="font-size:12px">${r.day}-го числа</div></td><td class="num">${money(r.amount)}</td>
          <td style="white-space:nowrap"><button class="chip" data-rec-toggle="${r.id}" data-active="${r.active}">${r.active ? 'Выкл.' : 'Вкл.'}</button> <button class="chip" data-rec-del="${r.id}" aria-label="Удалить">×</button></td></tr>`).join('')}</tbody></table>` : '<div class="muted">Пока нет.</div>'}
        ${rec.suggestions.length ? `<div class="hint">Нашёл в вашей истории повторяющиеся платежи:<div class="cats" style="margin-top:6px">${rec.suggestions.map((g, i) => `<button class="chip" data-rec-add="${i}">+ ${esc(g.category)} · ${money0(g.amount)} · ~${g.day}-го</button>`).join('')}</div></div>` : ''}
        <form id="recForm" class="two-col">
          <label class="field"><span>Категория</span><input name="category" required list="catListRec" maxlength="60"></label>
          <label class="field"><span>Сумма</span><input name="amount" inputmode="decimal" required></label>
          <label class="field"><span>День месяца</span><input name="day" type="number" min="1" max="31" required value="15"></label>
          <label class="field"><span>Тип</span><select name="kind"><option value="expense">Расход</option><option value="withdrawal">Снятие</option><option value="topup">Пополнение</option></select></label>
          <button class="btn" type="submit" style="grid-column:1/-1">Добавить регулярный платёж</button></form>
        <datalist id="catListRec">${(state.meta.categories.expense || []).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="err" id="recErr"></div>
      </div>

      <div class="card stack">
        <h2>Сверка с выплатой Kaspi</h2>
        <div class="muted" style="font-size:13px">Когда Kaspi перечислил деньги, введите сумму поступления за период. Комиссия и доставка у продаж, помеченных «≈», подгонятся так, чтобы итог совпал до копейки. Сверенные вручную продажи не меняются.</div>
        <form id="recoForm" class="stack">
          <div class="two-col"><label class="field"><span>С</span><input type="date" name="from" value="${month.from}" required></label><label class="field"><span>По</span><input type="date" name="to" value="${month.to}" required></label></div>
          <label class="field"><span>Поступило «чистыми», ₸</span><input name="actualNet" inputmode="decimal" required placeholder="0"></label>
          <div class="btns"><button class="btn ghost" type="submit" data-act="dry">Посмотреть разницу</button><button class="btn" type="submit" data-act="apply" disabled>Применить сверку</button></div>
          <div id="recoOut" class="muted"></div>
        </form>
      </div>
    </div>`;

    window.scrollTo(0, y); // обновление после действия не должно отбрасывать наверх
    // --- Kaspi ---
    const kOut = $('#kOut');
    if (kOut && kaspiMsg) kOut.innerHTML = kaspiMsg;
    const kRun = async (dry) => {
      kOut.textContent = 'Запрашиваю Kaspi…';
      try {
        const r = await api(`/kaspi/sync${dry ? '?dryRun=1' : ''}`, { method: 'POST' });
        kOut.innerHTML = `Заказов получено: <b>${r.fetched}</b>, завершённых: ${r.completed}, ${dry ? 'будет добавлено' : 'добавлено'}: <b>${r.added}</b>${r.returned ? `, возвратов/отмен к проверке: <b>${r.returned}</b>` : ''}.
          ${r.unknownCategories.length ? `<div class="hint" style="margin-top:8px">Нет ставки для категорий: ${r.unknownCategories.map((u) => esc(u.category)).join(', ')}.</div>` : ''}
          ${dry && r.sample.length ? `<div style="margin-top:8px">${r.sample.map((e) => `<div class="log-item">${esc(e.date)} · ${money(e.amount)} · комиссия ≈ ${money(e.commission)}<small>${esc(e.category || 'категория не указана')} · ${esc(e.note)}</small></div>`).join('')}</div>` : ''}`;
        if (!dry) { const html = kOut.innerHTML; toast(`Добавлено продаж: ${r.added}`); await load({ silent: true }); await renderAuto(main, html); }
      } catch (e) { kOut.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
    };
    $('#kTest')?.addEventListener('click', () => kRun(true));
    $('#kSync')?.addEventListener('click', () => kRun(false));

    // --- ставки ---
    const rateErr = (m) => { $('#rateErr').textContent = m; };
    $('#rateForm').addEventListener('submit', async (ev) => {
      ev.preventDefault(); const f = ev.target;
      try { await api('/rates', { method: 'PUT', body: { category: f.category.value, percent: f.percent.value } }); toast('Ставка сохранена'); renderAuto(main); }
      catch (e) { rateErr(e.message); }
    });
    document.querySelectorAll('[data-rate-del]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/rates?category=${encodeURIComponent(b.dataset.rateDel)}`, { method: 'DELETE' }); renderAuto(main);
    }));
    document.querySelectorAll('[data-rate-pick]').forEach((b) => b.addEventListener('click', () => {
      const f = $('#rateForm'); f.category.value = b.dataset.ratePick; f.percent.focus();
    }));
    $('#recalc').addEventListener('click', async () => {
      try { const r = await api('/rates/recalc', { method: 'POST' }); toast(`Пересчитано продаж: ${r.updated}`); await load({ silent: true }); }
      catch (e) { rateErr(e.message); }
    });

    // --- регулярные платежи ---
    const recErr = (m) => { $('#recErr').textContent = m; };
    $('#recForm').addEventListener('submit', async (ev) => {
      ev.preventDefault(); const f = ev.target;
      try { await api('/recurring', { method: 'POST', body: { kind: f.kind.value, category: f.category.value, amount: f.amount.value, day: f.day.value } }); toast('Добавлено'); await load({ silent: true }); renderAuto(main); }
      catch (e) { recErr(e.message); }
    });
    document.querySelectorAll('[data-rec-add]').forEach((b) => b.addEventListener('click', async () => {
      const g = rec.suggestions[Number(b.dataset.recAdd)];
      try { await api('/recurring', { method: 'POST', body: { kind: g.kind, category: g.category, amount: g.amount, day: g.day } }); toast('Добавлено'); await load({ silent: true }); renderAuto(main); }
      catch (e) { recErr(e.message); }
    }));
    document.querySelectorAll('[data-rec-toggle]').forEach((b) => b.addEventListener('click', async () => {
      await api(`/recurring/${b.dataset.recToggle}`, { method: 'PUT', body: { active: b.dataset.active !== '1' } }); await load({ silent: true }); renderAuto(main);
    }));
    document.querySelectorAll('[data-rec-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Удалить регулярный платёж? Уже внесённые операции останутся.')) return;
      await api(`/recurring/${b.dataset.recDel}`, { method: 'DELETE' }); await load({ silent: true }); renderAuto(main);
    }));

    // --- сверка ---
    const reco = $('#recoForm'); const applyBtn = reco.querySelector('[data-act=apply]');
    let act = 'dry';
    reco.querySelectorAll('[type=submit]').forEach((b) => b.addEventListener('click', () => { act = b.dataset.act; }));
    reco.addEventListener('input', () => { applyBtn.disabled = true; });
    reco.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = { from: reco.from.value, to: reco.to.value, actualNet: reco.actualNet.value };
      const out = $('#recoOut');
      try {
        const r = await api(`/reconcile${act === 'dry' ? '?dryRun=1' : ''}`, { method: 'POST', body });
        if (act === 'dry') {
          out.innerHTML = `Приблизительных продаж: <b>${r.count}</b>. Сейчас в учёте «чистыми» (по периоду): <b>${money(r.netBefore)}</b>, по выплате: <b>${money(r.netAfter)}</b>, разница: <b class="${r.difference < 0 ? 'neg' : 'pos'}">${signed(r.difference)}</b>.`;
          applyBtn.disabled = false;
        } else { out.innerHTML = `Готово: сверено продаж — ${r.count}, итог ${money(r.netAfter)}.`; toast('Сверено'); applyBtn.disabled = true; await load({ silent: true }); }
      } catch (e) { out.innerHTML = `<span class="neg">${esc(e.message)}</span>`; }
    });
  }

  // ---------- «Ещё» ----------
  function renderMore(main) {
    const r = rangeFor(state.period, state.custom);
    main.innerHTML = `
      <div class="stack" style="max-width:640px;margin:0 auto">
        <div class="card stack">
          <h2>Выгрузка в Excel</h2>
          <div class="muted">Листы: «Операции» (с фильтрами и формулами), «По месяцам», «Расходы по категориям».</div>
          <a class="btn" style="text-align:center;text-decoration:none" id="exCur" href="/api/export.xlsx?${query()}">Скачать: ${r.from ? `${parse(r.from).toLocaleDateString('ru-RU')} — ${parse(r.to).toLocaleDateString('ru-RU')}` : 'всё время'}</a>
          <a class="btn ghost" style="text-align:center;text-decoration:none" href="/api/export.xlsx">Скачать всё за всё время</a>
          <div class="muted" style="font-size:13px">Период меняется на вкладке «Обзор» или «Операции».</div>
        </div>
        <div class="card stack">
          <h2>Загрузить из вашей таблицы</h2>
          <div class="muted">Файл .xlsx в вашем формате (Дата · Заказ/Продажа… · Сумма · Снятия · Пополнения · за продажи · доставка · пакет · этикетка). Повторная загрузка не создаёт дублей.</div>
          <input type="file" id="file" accept=".xlsx" aria-label="Файл Excel">
          <div id="importOut" class="muted"></div>
        </div>
        <div class="card"><h2>Журнал изменений</h2><div id="activity" class="muted">Загрузка…</div></div>
        <div class="card stack">
          <h2>Установить на телефон</h2>
          <div class="muted">iPhone: Safari → «Поделиться» → «На экран Домой». Android: Chrome → ⋮ → «Установить приложение».</div>
          <button class="btn ghost" id="logout">Выйти (${esc(state.user)})</button>
        </div>
      </div>`;
    $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); state.user = null; renderLogin(); });
    $('#file').addEventListener('change', onFile);
    api('/activity').then(({ activity }) => {
      const L = { create: 'добавил', update: 'изменил', delete: 'удалил', import: 'загрузил' };
      $('#activity').innerHTML = activity.length
        ? activity.map((a) => `<div class="log-item"><b>${esc(a.user)}</b> ${L[a.action] || a.action}<small>${esc(a.summary)} · ${fmtDateTime(a.at)}</small></div>`).join('')
        : 'Пока пусто';
    }).catch(() => {});
  }

  async function onFile(ev) {
    const file = ev.target.files[0]; const out = $('#importOut');
    if (!file) return;
    out.textContent = 'Читаю файл…';
    try {
      const buf = await file.arrayBuffer();
      const send = (dry) => fetch(`/api/import${dry ? '?dryRun=1' : ''}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: buf })
        .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
      const p = await send(true);
      out.innerHTML = `Найдено операций: <b>${p.found}</b>. Новых: <b>${p.added}</b>, уже есть: ${p.duplicates}, пропущено строк (пустые дни, итоги): ${p.ignored}.
        ${p.errors.length ? `<div class="err">Ошибки: ${p.errors.map(esc).join('; ')}</div>` : ''}
        ${p.added ? '<div style="margin-top:10px"><button class="btn" id="doImport">Загрузить ' + p.added + ' операций</button></div>' : ''}`;
      $('#doImport')?.addEventListener('click', async (e2) => {
        e2.target.disabled = true;
        try { const d = await send(false); toast(`Загружено: ${d.added}`); ev.target.value = ''; out.textContent = `Готово: добавлено ${d.added}.`; await load({ silent: true }); }
        catch (err) { out.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
      });
    } catch (err) { out.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  }

  // ---------- синхронизация между устройствами ----------
  async function poll() {
    if (!state.user || document.hidden || document.querySelector('dialog[open]')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return; // не мешаем вводу
    try {
      const { rev } = await api('/rev');
      if (rev !== state.rev) { await load({ silent: true }); }
    } catch { /* нет сети — попробуем в следующий раз */ }
  }
  setInterval(poll, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('online', poll);

  // ---------- запуск ----------
  async function start() {
    try {
      state.meta = await api('/meta');
      state.user = state.meta.user;
    } catch { return; }
    const h = location.hash.slice(1);
    if (['overview', 'ops', 'auto', 'more'].includes(h)) state.view = h;
    renderShell();
    await load();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  start();
})();
