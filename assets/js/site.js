/* Belur Immobilien – gemeinsames Seitenverhalten (alle Seiten) */
(function () {
  document.documentElement.classList.add('js');

  // Aktuelle Seite in der Navigation markieren
  var seite = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav a, .mobile-nav a.mnav-link').forEach(function (a) {
    var ziel = a.getAttribute('href').split('#')[0].split('/').pop();
    if (ziel && ziel === seite) a.setAttribute('aria-current', 'page');
  });

  // Header: Schatten beim Scrollen
  var header = document.querySelector('.site-header');
  function onScroll() { if (header) header.classList.toggle('is-scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // Mobiles Menü
  var toggle = document.querySelector('.nav-toggle');
  var mnav = document.getElementById('mobile-nav');
  function setNav(open) {
    if (!toggle || !mnav) return;
    toggle.setAttribute('aria-expanded', String(open));
    mnav.classList.toggle('is-open', open);
    document.body.classList.toggle('nav-open', open);
  }
  if (toggle && mnav) {
    toggle.addEventListener('click', function () { setNav(toggle.getAttribute('aria-expanded') !== 'true'); });
    mnav.addEventListener('click', function (e) { if (e.target.closest('a')) setNav(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setNav(false); });
  }

  // Dezente Einblendung
  var items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('is-visible'); io.unobserve(en.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach(function (el) { io.observe(el); });
  } else { items.forEach(function (el) { el.classList.add('is-visible'); }); }

  // Calendly erst nach aktivem Klick laden (Datenübertragung in die USA nur mit Zustimmung)
  document.querySelectorAll('[data-calendly]').forEach(function (btn) {
    btn.addEventListener('click', function () { window.belurLoadCalendly(); });
  });
  window.belurLoadCalendly = function () {
    var box = document.getElementById('calBox'), ph = document.getElementById('calPh');
    if (!box || box.dataset.loaded) { if (box) box.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    box.dataset.loaded = '1';
    if (ph) ph.hidden = true;
    box.innerHTML = '<div class="calendly-inline-widget" data-url="https://calendly.com/ebelur/kontaktformular?hide_gdpr_banner=1&background_color=ffffff&text_color=0b1526&primary_color=0b1526" style="min-width:300px;height:680px"></div>';
    var s = document.createElement('script'); s.src = 'https://assets.calendly.com/assets/external/widget.js'; s.async = true;
    document.body.appendChild(s);
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Wertermittlungs-Einstieg (Startseite, Stadtseiten): Objektart + PLZ → weiter in den Assistenten
  document.querySelectorAll('form[data-teaser]').forEach(function (form) {
    var typ = form.querySelector('input[name="typ"]'), plz = form.querySelector('input[name="plz"]');
    form.querySelectorAll('.tile[data-typ]').forEach(function (t) {
      t.addEventListener('click', function () {
        form.querySelectorAll('.tile[data-typ]').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        t.setAttribute('aria-pressed', 'true'); typ.value = t.dataset.typ;
      });
    });
    form.addEventListener('submit', function (e) {
      if (plz.value && !/^\d{5}$/.test(plz.value.trim())) { e.preventDefault(); plz.focus(); alert('Bitte geben Sie eine gültige 5-stellige Postleitzahl ein.'); return; }
      if (!typ.value) typ.disabled = true;
      if (!plz.value) plz.disabled = true;
    });
  });

  // Filter auf der Angebotsseite
  var chips = document.querySelectorAll('.chip[data-filter]');
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var f = chip.dataset.filter, shown = 0;
      chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
      document.querySelectorAll('[data-type]').forEach(function (card) {
        var ok = f === 'alle' || card.dataset.type === f;
        card.hidden = !ok; if (ok) shown++;
      });
      var empty = document.getElementById('filter-empty');
      if (empty) empty.hidden = shown > 0;
    });
  });

  // Lightbox für Galerien: <button data-lb="bild.jpg" data-cap="Text">
  var lbItems = Array.prototype.slice.call(document.querySelectorAll('[data-lb]'));
  if (lbItems.length) {
    var lb = document.createElement('div');
    lb.className = 'lightbox'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Bildansicht');
    lb.innerHTML = '<button class="lb-btn lb-close" aria-label="Schließen">×</button><button class="lb-btn lb-prev" aria-label="Vorheriges Bild">‹</button>' +
      '<figure><img alt=""><figcaption></figcaption></figure><button class="lb-btn lb-next" aria-label="Nächstes Bild">›</button>';
    document.body.appendChild(lb);
    var img = lb.querySelector('img'), cap = lb.querySelector('figcaption'), idx = 0, last = null;
    function show(i) {
      idx = (i + lbItems.length) % lbItems.length;
      var it = lbItems[idx];
      img.src = it.dataset.lb; img.alt = it.dataset.cap || '';
      cap.textContent = (it.dataset.cap || '') + '  ·  ' + (idx + 1) + ' / ' + lbItems.length;
    }
    function open(i) { last = document.activeElement; show(i); lb.classList.add('is-open'); document.body.style.overflow = 'hidden'; lb.querySelector('.lb-close').focus(); }
    function close() { lb.classList.remove('is-open'); document.body.style.overflow = ''; if (last) last.focus(); }
    lbItems.forEach(function (it, i) { it.addEventListener('click', function () { open(i); }); });
    lb.querySelector('.lb-close').addEventListener('click', close);
    lb.querySelector('.lb-prev').addEventListener('click', function () { show(idx - 1); });
    lb.querySelector('.lb-next').addEventListener('click', function () { show(idx + 1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
    document.addEventListener('keydown', function (e) {
      if (!lb.classList.contains('is-open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });
    var tx = null;
    lb.addEventListener('touchstart', function (e) { tx = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      if (tx === null) return; var dx = e.changedTouches[0].clientX - tx; tx = null;
      if (Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
    });
  }
})();
