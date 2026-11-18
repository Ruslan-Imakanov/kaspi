(function () {
  'use strict';

  var WA_NUMBER = '77075251000';
  var doc = document.documentElement;
  doc.classList.add('js');

  /* Header shadow on scroll */
  var header = document.querySelector('.header');
  function onScroll() { header.classList.toggle('is-scrolled', window.scrollY > 8); }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* Mobile menu */
  var burger = document.querySelector('.burger');
  var nav = document.getElementById('nav');
  function setMenu(open) {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    nav.classList.toggle('is-open', open);
  }
  burger.addEventListener('click', function () { setMenu(burger.getAttribute('aria-expanded') !== 'true'); });
  nav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
  window.addEventListener('resize', function () { if (window.innerWidth > 1040) setMenu(false); });

  /* WhatsApp links: data-wa="text" sets the message (empty = greeting),
     data-wa-to="7..." sends it to another number (used by the developer credit). */
  var greeting = 'Здравствуйте! Хочу заказать оценку.';
  function waLink(text, to) {
    return 'https://wa.me/' + String(to || WA_NUMBER).replace(/\D/g, '') + '?text=' + encodeURIComponent(text);
  }
  document.querySelectorAll('a[data-wa]').forEach(function (a) {
    a.href = waLink(a.getAttribute('data-wa') || greeting, a.getAttribute('data-wa-to'));
  });

  /* Documents tabs (ARIA tabs pattern) */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
  function selectTab(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { selectTab(tab); });
    tab.addEventListener('keydown', function (e) {
      var next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      if (e.key === 'Home') next = tabs[0];
      if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });

  /* Copy promo codes */
  var copyTimer;
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    var card = btn.closest('.promo__code');
    var status = card && card.querySelector('.promo__copied');
    btn.addEventListener('click', function () {
      var code = btn.getAttribute('data-copy');
      function done(ok) {
        if (!status) return;
        status.textContent = ok ? 'Промокод ' + code + ' скопирован' : 'Промокод: ' + code;
        clearTimeout(copyTimer);
        copyTimer = setTimeout(function () { status.textContent = ''; }, 2500);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { done(true); }, function () { done(false); });
      } else {
        done(false);
      }
    });
  });

  /* Request form -> WhatsApp message */
  var form = document.getElementById('request-form');
  var errorBox = document.getElementById('form-error');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = new FormData(form);
    var phone = String(data.get('phone') || '').trim();
    var digits = phone.replace(/\D/g, '');
    var phoneInput = form.elements.phone;

    if (digits.length < 10) {
      errorBox.hidden = false;
      phoneInput.setAttribute('aria-invalid', 'true');
      phoneInput.focus();
      return;
    }
    errorBox.hidden = true;
    phoneInput.removeAttribute('aria-invalid');

    var lines = [
      'Здравствуйте! Заявка на оценку с сайта ADAL PRICE.',
      'Имя: ' + (String(data.get('name') || '').trim() || '—'),
      'Телефон: ' + phone,
      'Объект: ' + data.get('object'),
      'Цель: ' + data.get('purpose')
    ];
    var comment = String(data.get('comment') || '').trim();
    if (comment) lines.push('Комментарий: ' + comment);
    var promo = String(data.get('promo') || '').trim().toUpperCase();
    if (promo) lines.push('Промокод: ' + promo);

    window.open(waLink(lines.join('\n')), '_blank', 'noopener');
  });
  form.elements.phone.addEventListener('input', function () {
    if (this.value.replace(/\D/g, '').length >= 10) {
      errorBox.hidden = true;
      this.removeAttribute('aria-invalid');
    }
  });

  /* Highlight current section in the nav */
  var links = Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]'));
  if ('IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (l) { byId[l.getAttribute('href').slice(1)] = l; });
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (l) { l.classList.remove('is-active'); });
        var link = byId[entry.target.id];
        if (link) link.classList.add('is-active');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll('main > section[id]').forEach(function (el) { spy.observe(el); });

    /* Reveal on scroll */
    var reveal = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          reveal.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    document.querySelectorAll('.reveal').forEach(function (el) {
      /* cards in one row appear one after another */
      var index = Array.prototype.indexOf.call(el.parentNode.children, el);
      el.style.animationDelay = (index % 6) * 90 + 'ms';
      reveal.observe(el);
    });
    document.querySelectorAll('[data-draw]').forEach(function (el) { reveal.observe(el); });
  } else {
    document.querySelectorAll('.reveal, [data-draw]').forEach(function (el) { el.classList.add('is-visible'); });
  }

  /* Apartment price calculator.
     Market level: average asking price per m² in Astana from Krisha.kz (data-avg on the form, updated by hand).
     Coefficients: district, rooms, year, condition, housing class and floor (ADAL PRICE model). */
  var calc = document.getElementById('calc-form');
  if (calc) {
    var DISTRICT = { esil: 1.183, nura: 1.004, sarayshyk: 0.972, almaty: 0.859, saryarka: 0.778, baikonur: 0.786 };
    var ROOMS = { 1: 1.08, 2: 1, 3: 0.96, 4: 0.93 };
    var YEAR = { y1: 0.82, y2: 0.86, y3: 0.9, y4: 0.96, y5: 1, y6: 1.04, y7: 1.08 };
    var CONDITION = { bad: 0.9, mid: 1, good: 1.06, top: 1.12 };
    var TIER = { econ: 0.9, comf: 1, biz: 1.2, prem: 1.4 };
    var FLOOR = { first: 0.95, mid: 1, last: 0.97 };
    var marketAvg = parseFloat(calc.getAttribute('data-avg')) || 617300;
    var f = calc.elements;
    var calcError = document.getElementById('calc-error');
    var money = function (n) { return n.toLocaleString('ru-RU'); };
    var text = function (select) { return select.options[select.selectedIndex].text; };

    calc.addEventListener('submit', function (e) {
      e.preventDefault();
      var area = parseFloat(String(f.area.value).replace(',', '.'));
      if (!(area >= 10 && area <= 500)) {
        calcError.hidden = false;
        f.area.setAttribute('aria-invalid', 'true');
        f.area.focus();
        return;
      }
      calcError.hidden = true;
      f.area.removeAttribute('aria-invalid');

      var district = f.district.value;
      var perM2 = marketAvg * DISTRICT[district] * ROOMS[f.rooms.value] * YEAR[f.year.value] *
        CONDITION[f.condition.value] * TIER[f.tier.value] * FLOOR[f.floor.value];
      var total = perM2 * area;
      var spread = district === 'esil' ? 0.15 : 0.08; /* Esil has the widest price range */
      var lo = Math.round(total * (1 - spread) / 100000) / 10;
      var hi = Math.round(total * (1 + spread) / 100000) / 10;
      var range = 'от ' + money(lo) + ' до ' + money(hi) + ' млн ₸';

      /* non-breaking spaces keep "до 50,4 млн ₸" on one line */
      document.getElementById('calc-sum').textContent = 'от ' + money(lo) + ' до\u00a0' + money(hi) + '\u00a0млн\u00a0₸';
      document.getElementById('calc-ppm').textContent = 'около ' + money(Math.round(perM2 / 1000) * 1000) + ' ₸ за м²';
      document.getElementById('calc-wa').href = waLink([
        'Здравствуйте! Хочу заказать оценку квартиры.',
        'Район: ' + text(f.district),
        'Класс: ' + text(f.tier),
        'Площадь: ' + area + ' м²',
        'Комнат: ' + text(f.rooms),
        'Примерный расчёт на сайте: ' + range
      ].join('\n'));
      var rooms = f.rooms.value;
      document.getElementById('calc-krisha').href = 'https://krisha.kz/prodazha/kvartiry/astana/?das%5Blive.rooms%5D=' + rooms;
      document.getElementById('calc-krisha-text').textContent = rooms + '-комнатные на Krisha.kz';

      document.getElementById('calc-placeholder').hidden = true;
      var answer = document.getElementById('calc-answer');
      answer.hidden = false;
      if (window.innerWidth <= 920) answer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    f.area.addEventListener('input', function () {
      var area = parseFloat(String(f.area.value).replace(',', '.'));
      if (area >= 10 && area <= 500) { calcError.hidden = true; f.area.removeAttribute('aria-invalid'); }
    });
  }

  /* Thank-you letters, published by the company in /admin */
  var lettersBox = document.getElementById('letters');
  if (lettersBox && window.fetch) {
    fetch('/api/letters', { cache: 'no-cache' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var letters = (data && data.letters) || [];
        if (!letters.length) return;
        var images = letters.filter(function (l) { return l.kind !== 'pdf'; });
        var grid = document.getElementById('letters-grid');
        var dialog = document.getElementById('lightbox');
        var big = document.getElementById('lightbox-img');
        var caption = document.getElementById('lightbox-cap');
        var current = 0;
        var svgIcon = function (id) {
          var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
          svg.setAttribute('class', 'ic');
          svg.setAttribute('aria-hidden', 'true');
          use.setAttribute('href', id);
          svg.appendChild(use);
          return svg;
        };
        var label = function (l) { return l.title + (l.date ? ' · ' + l.date : ''); };

        function openLetter(i) {
          current = (i + images.length) % images.length;
          var l = images[current];
          big.src = '/letters/' + l.id + '/full.jpg';
          big.width = l.w;
          big.height = l.h;
          big.alt = 'Благодарственное письмо: ' + l.title;
          caption.textContent = label(l);
          if (!dialog.showModal) { window.open(big.src, '_blank', 'noopener'); return; }
          if (!dialog.open) dialog.showModal();
        }

        letters.forEach(function (l) {
          var item = document.createElement('li');
          var card;
          if (l.kind === 'pdf') {
            card = document.createElement('a');
            card.href = '/letters/' + l.id + '.pdf';
            card.target = '_blank';
            card.rel = 'noopener';
            card.className = 'letter letter--pdf';
            var doc = document.createElement('span');
            doc.className = 'letter__doc';
            doc.appendChild(svgIcon('#i-file'));
            card.appendChild(doc);
          } else {
            card = document.createElement('button');
            card.type = 'button';
            card.className = 'letter';
            var img = document.createElement('img');
            img.src = '/letters/' + l.id + '/thumb.jpg';
            img.alt = 'Благодарственное письмо: ' + l.title;
            img.loading = 'lazy';
            img.width = 600;
            img.height = Math.round(600 * (l.h || 1414) / (l.w || 1000));
            card.appendChild(img);
            card.addEventListener('click', function () { openLetter(images.indexOf(l)); });
          }
          var title = document.createElement('span');
          title.className = 'letter__title';
          title.textContent = l.title;
          card.appendChild(title);
          if (l.date) {
            var date = document.createElement('span');
            date.className = 'letter__date';
            date.textContent = l.date;
            card.appendChild(date);
          }
          item.appendChild(card);
          grid.appendChild(item);
        });

        dialog.querySelectorAll('[data-step]').forEach(function (btn) {
          btn.hidden = images.length < 2;
          btn.addEventListener('click', function () { openLetter(current + Number(btn.getAttribute('data-step'))); });
        });
        dialog.querySelector('[data-close]').addEventListener('click', function () { dialog.close(); });
        dialog.addEventListener('click', function (e) { if (e.target === dialog) dialog.close(); });
        dialog.addEventListener('keydown', function (e) {
          if (images.length < 2) return;
          if (e.key === 'ArrowRight') openLetter(current + 1);
          if (e.key === 'ArrowLeft') openLetter(current - 1);
        });
        lettersBox.hidden = false;
      })
      .catch(function () { /* no letters service (e.g. plain static hosting): the block stays hidden */ });
  }

  /* Footer year */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
