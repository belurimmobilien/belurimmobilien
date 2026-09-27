/* Belur Immobilien – Formularversand über Netlify Forms.
   Jeder Lead wird bei Netlify gespeichert (Dashboard → Forms) und löst die
   E-Mail-Benachrichtigung sowie die Function submission-created aus.
   Formulardefinitionen („bewertung“, „kontakt“) stehen versteckt in index.html. */
(function () {
  var PHONE = '0176 84143342';
  var PHONE_LINK = 'tel:+4917684143342';

  // Steht der Button in einer Flex-Zeile (z. B. Zurück/Weiter), kommt der Hinweis unter die ganze Zeile.
  function anchorFor(btn) {
    var parent = btn.parentElement;
    return parent && getComputedStyle(parent).display.indexOf('flex') !== -1 ? parent : btn;
  }

  function clearError(btn) {
    var anchor = btn && anchorFor(btn);
    var next = anchor && anchor.nextElementSibling;
    if (next && next.classList.contains('lead-err')) next.remove();
  }

  function showError(btn) {
    if (!btn) return;
    clearError(btn);
    var p = document.createElement('p');
    p.className = 'lead-err';
    p.setAttribute('role', 'alert');
    p.innerHTML = 'Ihre Anfrage konnte gerade nicht gesendet werden. Bitte versuchen Sie es erneut oder rufen Sie uns direkt an: ' +
      '<a href="' + PHONE_LINK + '">' + PHONE + '</a>.';
    anchorFor(btn).insertAdjacentElement('afterend', p);
  }

  /**
   * Sendet einen Lead. Gibt true zurück, wenn Netlify ihn angenommen hat.
   * @param {string} formName  'bewertung' | 'kontakt'
   * @param {Object} fields    Feldname → Wert (Namen wie in den versteckten Formularen)
   * @param {HTMLElement} btn  Absende-Button (für Ladezustand und Fehlermeldung)
   */
  window.belurSendLead = async function (formName, fields, btn) {
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Wird gesendet …'; clearError(btn); }

    var body = new URLSearchParams();
    body.append('form-name', formName);
    body.append('seite', location.pathname);
    // Kampagne aus der aktuellen Adresse (z. B. /filderstadt → ?utm_source=postwurf&utm_campaign=filderstadt).
    // Bewusst ohne Speicherung im Browser (kein Cookie/Storage → keine Einwilligung nötig).
    var q = new URLSearchParams(location.search);
    var kampagne = ['utm_source', 'utm_medium', 'utm_campaign'].map(function (k) { return q.get(k); }).filter(Boolean).join(' / ');
    body.append('kampagne', kampagne.slice(0, 120));
    Object.keys(fields).forEach(function (k) {
      var v = fields[k];
      body.append(k, v == null ? '' : String(v));
    });

    try {
      var res = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return true;
    } catch (err) {
      console.error('Lead-Versand fehlgeschlagen:', err);
      if (btn) { btn.disabled = false; btn.textContent = label; }
      showError(btn);
      return false;
    }
  };

  window.belurValidEmail = function (email) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  };
})();
