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
  window.addEventListener('resize', function () { if (window.innerWidth > 920) setMenu(false); });

  /* Default WhatsApp greeting on every WhatsApp link */
  var greeting = 'Здравствуйте! Хочу заказать оценку.';
  document.querySelectorAll('a[data-wa]').forEach(function (a) {
    a.href = 'https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(greeting);
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

    window.open('https://wa.me/' + WA_NUMBER + '?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
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
    ['home'].concat(Object.keys(byId)).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });

    /* Reveal on scroll */
    var reveal = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          reveal.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    document.querySelectorAll('.reveal').forEach(function (el, i) {
      el.style.transitionDelay = (i % 4) * 70 + 'ms';
      reveal.observe(el);
    });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('is-visible'); });
  }

  /* Footer year */
  var year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
