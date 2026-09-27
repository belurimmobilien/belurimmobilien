/* Belur Immobilien – Werteinschätzung nach allen drei Verfahren der ImmoWertV
   (Vergleichswert-, Ertragswert-, Sachwertverfahren), vereinfacht für den Online-Wertermittler.
   Methodik wie im Belur-Gutachten (Beispiel Rebhuhnweg 12/1, Juni 2026).
   Eine Quelle für Browser (window.belurWert) und Netlify Functions (globalThis.belurWert).
   Marktdaten: preise.json (Kauf- und Mietpreise €/m², Bodenrichtwerte je Gemeinde).
   Alle Modellannahmen stehen in PARAM und werden hier zentral gepflegt. Ergebnis = Orientierung, kein Gutachten. */
(function (root) {
  var PARAM = {
    gnd: 70,                          // Gesamtnutzungsdauer (Jahre), wie Belur-Gutachten
    // Mindest-Restnutzungsdauer je Zustand (vereinfachte Modernisierungsberücksichtigung, vgl. ImmoWertV Anlage 2)
    minRnd: { 'Neuwertig / saniert': 40, 'Gepflegt': 20, 'Renovierungsbedarf': 15, 'Unsaniert': 10 },
    baujahr: { 'Vor 1960': 1955, '1960–1980': 1970, '1980–2000': 1990, '2000–2015': 2008, 'Nach 2015': 2019 },
    baujahrStandard: 1985,            // wenn kein Baujahr angegeben
    // Vergleichswert: Zu-/Abschläge auf den Ø Angebotspreis
    zustand: { 'Neuwertig / saniert': 1.10, 'Gepflegt': 1.0, 'Renovierungsbedarf': 0.88, 'Unsaniert': 0.78 },
    alter:   { 'Vor 1960': 0.96, '1960–1980': 0.95, '1980–2000': 1.0, '2000–2015': 1.05, 'Nach 2015': 1.10 },
    lage:    { 'Sehr gute Lage': 1.08, 'Gute / durchschnittliche Lage': 1.0, 'Einfache Lage': 0.92 },
    // Ertragswert: Mietansatz je Zustand, Bewirtschaftungskosten, Liegenschaftszins
    mieteZustand: { 'Neuwertig / saniert': 1.08, 'Gepflegt': 1.0, 'Renovierungsbedarf': 0.95, 'Unsaniert': 0.90 },
    // Sachwert: Herstellungskosten neu je m² Wohnfläche (inkl. Baunebenkosten, Stand 2026), Außenanlagen
    aussenanlagen: 0.04,
    grundanteilEtw: 0.9,              // m² Grundstücksanteil je m² Wohnfläche bei ETW (Annahme wie Gutachten)
    spanne: 0.07,                     // ± um den gewichteten Marktwert
    // Garage / Stellplatz (wie Gutachten Rebhuhnweg: Garage ca. 16.000 €, Miete 80 €/Monat, Herstellung 25.000 €),
    // skaliert mit dem regionalen Preisniveau (Ø Hauspreis der Gemeinde / 3.560 €/m² Schwäbisch Gmünd), begrenzt auf 0,8–1,6
    garage:     { wert: 16000, miete: 80, herstellung: 25000 },
    stellplatz: { wert: 5000,  miete: 30, herstellung: 4000 },
    preisniveauBasis: 3560,
    // Auswahl im Formular → Anzahl Garagen / Außenstellplätze
    stellplatzOptionen: {
      'Keine': [0, 0], '1 Außenstellplatz': [0, 1], '2 Außenstellplätze': [0, 2], '1 Garage': [1, 0],
      'Garage + Stellplatz': [1, 1], 'Doppelgarage / 2 Garagen': [2, 0], 'Doppelgarage + 2 Stellplätze': [2, 2]
    }
  };

  // je Objektart: Marktdaten-Spalte, Liegenschaftszins (mittlere Lage), BWK-Satz, Herstellungskosten, Standard-Grundstück, Gewichtung
  var TYP = {
    'Einfamilienhaus':  { k: 'kh', m: 'mh', lz: 0.025, bwk: 0.15, hk: 2500, grund: 500, faktor: 1.0,  gew: { vergleich: 0.5, ertrag: 0.1, sach: 0.4 } },
    'Mehrfamilienhaus': { k: 'kh', m: 'mw', lz: 0.035, bwk: 0.18, hk: 2300, grund: 600, faktor: 0.92, gew: { vergleich: 0.3, ertrag: 0.6, sach: 0.1 } },
    'Eigentumswohnung': { k: 'kw', m: 'mw', lz: 0.035, bwk: 0.15, hk: 2200, grund: null, faktor: 1.0, gew: { vergleich: 0.6, ertrag: 0.2, sach: 0.2 } }
  };
  TYP['Wohnung'] = TYP['Eigentumswohnung'];

  /** Liegenschaftszins nach Lageniveau: teure Lagen (hoher Bodenrichtwert) niedriger, günstige höher. */
  function liegenschaftszins(typ, brw) {
    return typ.lz + (brw >= 500 ? -0.005 : brw < 200 ? 0.005 : 0);
  }

  /** Marktanpassungsfaktor (Sachwertfaktor) – Annahme nach Bodenrichtwertniveau; ETW mit Aufschlag (Gutachten Gmünd: 1,54). */
  function sachwertfaktor(brw, istEtw) {
    var f = brw < 150 ? 1.05 : brw < 300 ? 1.20 : brw < 500 ? 1.35 : brw < 800 ? 1.50 : 1.60;
    return istEtw ? f + 0.30 : f;
  }

  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]/g, '');
  }

  /** Sucht Gemeinde/Kreis zur PLZ. Mehrere Gemeinden je PLZ: Ort-Angabe entscheidet, sonst die erste mit eigenen Preisdaten. */
  function finde(preise, plz, ort) {
    var eintraege = preise && preise.plz && preise.plz[String(plz || '').trim()];
    if (!eintraege || !eintraege.length) return null;
    var o = norm(ort), wahl = null, i;
    if (o) {
      for (i = 0; i < eintraege.length && !wahl; i++) {
        var e = eintraege[i];
        if (norm(e[0]) === o || norm(e[1]) === o || norm(e[0]).indexOf(o) === 0 || norm(e[1]).indexOf(o) === 0) wahl = e;
      }
    }
    for (i = 0; i < eintraege.length && !wahl; i++) {
      var kk = preise.kreise[eintraege[i][2]];
      if (kk && kk.gemeinden[eintraege[i][0]]) wahl = eintraege[i];
    }
    wahl = wahl || eintraege[0];
    var kreis = preise.kreise[wahl[2]];
    if (!kreis) return null;
    var g = kreis.gemeinden[wahl[0]];
    var q = g || kreis;
    var brw = preise.brw && preise.brw[wahl[0]];
    return {
      gemeinde: wahl[0], ort: wahl[1], kreis: kreis.name,
      basis: g ? 'gemeinde' : 'kreis',
      kw: q.kw, kh: q.kh, mw: q.mw, mh: q.mh,
      brw: brw ? brw.wert : kreis.brw,
      brwBasis: brw ? (brw.geschaetzt ? 'geschaetzt' : 'gemeinde') : 'kreis',
      brwStichtag: brw ? brw.stichtag : preise.brwStichtag
    };
  }

  function zahl(x) { return parseFloat(String(x == null ? '' : x).replace(/\./g, '').replace(',', '.')); }
  function rund(n) { return Math.round(n / 5000) * 5000; }
  function vervielfaeltiger(p, n) { return (1 - Math.pow(1 + p, -n)) / p; }

  /**
   * @param preise  Inhalt von preise.json
   * @param d       { objektart, wohnflaeche, grundstueck?, garage?, zustand?, baujahr?, lage?, plz, ort? }
   * @returns { ok:true, von, bis, wert, verfahren:{vergleich,ertrag,sach}, gewichte, annahmen, gebiet, ... } | { ok:false, grund }
   */
  function schaetzen(preise, d) {
    if (d.objektart === 'Grundstück') return { ok: false, grund: 'grundstueck' };
    var typ = TYP[d.objektart];
    if (!typ) return { ok: false, grund: 'objektart' };
    var wf = zahl(String(d.wohnflaeche || '').replace(/[^\d,.]/g, ''));
    if (!(wf > 0)) return { ok: false, grund: 'flaeche' };
    var o = finde(preise, d.plz, d.ort);
    if (!o) return { ok: false, grund: 'region' };

    var istEtw = typ === TYP['Eigentumswohnung'];
    var lageF = PARAM.lage[d.lage] || 1;
    var jahr = new Date().getFullYear();
    var bj = PARAM.baujahr[d.baujahr] || PARAM.baujahrStandard;
    var alter = Math.max(0, jahr - bj);
    var rnd = Math.max(PARAM.gnd - alter, PARAM.minRnd[d.zustand] || 15);
    rnd = Math.min(rnd, PARAM.gnd);

    // Bodenwert
    var grundAngabe = zahl(String(d.grundstueck || '').replace(/[^\d,.]/g, ''));
    var grund = istEtw ? wf * PARAM.grundanteilEtw : (grundAngabe > 0 ? grundAngabe : typ.grund);
    var brw = o.brw * lageF;
    var bodenwert = brw * grund;

    // a) Vergleichswert
    var qm = o[typ.k] * typ.faktor * (PARAM.zustand[d.zustand] || 1) * (PARAM.alter[d.baujahr] || 1) * lageF;
    if (wf > 220) qm *= 0.94;
    if (istEtw && wf < 50) qm *= 1.05;
    // Garage / Stellplätze
    var gs = PARAM.stellplatzOptionen[d.garage] || [0, 0];
    var niveau = Math.min(1.6, Math.max(0.8, o.kh / PARAM.preisniveauBasis));
    var nG = gs[0], nS = gs[1];

    var vergleich = qm * wf + (nG * PARAM.garage.wert + nS * PARAM.stellplatz.wert) * niveau;

    // b) Ertragswert (allgemeines Verfahren: Bodenwert + Gebäudeertragswert)
    var miete = o[typ.m] * (PARAM.mieteZustand[d.zustand] || 1) * lageF;
    var mieteStellplaetze = (nG * PARAM.garage.miete + nS * PARAM.stellplatz.miete) * niveau;
    var rohertrag = miete * wf * 12 + mieteStellplaetze * 12;
    var reinertrag = rohertrag * (1 - typ.bwk);
    var lz = liegenschaftszins(typ, o.brw);
    var bodenverzinsung = bodenwert * lz;
    var vv = vervielfaeltiger(lz, rnd);
    var gebaeudeertrag = Math.max(0, reinertrag - bodenverzinsung) * vv;
    var ertrag = bodenwert + gebaeudeertrag;

    // c) Sachwert (Gebäudesachwert + Außenanlagen + Bodenwert) × Marktanpassung
    var awm = (PARAM.gnd - rnd) / PARAM.gnd;
    var gebaeude = (typ.hk * wf + (nG * PARAM.garage.herstellung + nS * PARAM.stellplatz.herstellung) * niveau) * (1 - awm);
    var vorlaeufig = gebaeude * (1 + PARAM.aussenanlagen) + bodenwert;
    var swf = sachwertfaktor(o.brw, istEtw);
    var sach = vorlaeufig * swf;

    // d) Gewichtete Synthese
    var g = typ.gew;
    var wert = vergleich * g.vergleich + ertrag * g.ertrag + sach * g.sach;
    var werte = [vergleich, ertrag, sach];
    var streuung = (Math.max.apply(null, werte) - Math.min.apply(null, werte)) / wert;

    return {
      ok: true,
      wert: rund(wert),
      von: rund(wert * (1 - PARAM.spanne)),
      bis: rund(wert * (1 + PARAM.spanne)),
      verfahren: { vergleich: rund(vergleich), ertrag: rund(ertrag), sach: rund(sach) },
      gewichte: { vergleich: g.vergleich, ertrag: g.ertrag, sach: g.sach },
      abweichungHoch: streuung > 0.35,
      annahmen: {
        vergleichQm: Math.round(qm / 10) * 10,
        miete: Math.round(miete * 100) / 100,
        rohertrag: Math.round(rohertrag), reinertrag: Math.round(reinertrag), bwkSatz: typ.bwk,
        liegenschaftszins: lz, restnutzungsdauer: rnd, vervielfaeltiger: Math.round(vv * 10) / 10,
        bodenrichtwert: Math.round(brw), grundstueck: Math.round(grund), grundstueckAngenommen: !istEtw && !(grundAngabe > 0),
        bodenwert: Math.round(bodenwert),
        herstellungskosten: typ.hk, alterswertminderung: Math.round(awm * 1000) / 10, sachwertfaktor: Math.round(swf * 100) / 100,
        garagen: nG, stellplaetze: nS, mieteStellplaetze: Math.round(mieteStellplaetze)
      },
      gebiet: o.basis === 'gemeinde' ? o.gemeinde : o.gemeinde + ' (Durchschnitt ' + o.kreis + ')',
      basis: o.basis, brwBasis: o.brwBasis, brwStichtag: o.brwStichtag,
      stand: preise.stand, quelle: preise.quelle
    };
  }

  function euro(n) { return Number(n).toLocaleString('de-DE') + ' €'; }

  /** Nur Browser: kleine Tabelle der drei Verfahren mit Gewichtung (erbt Farben/Schrift der Seite). */
  function tabelle(s) {
    var t = document.createElement('table');
    t.className = 'method-table';
    [['Vergleichswert', s.verfahren.vergleich, s.gewichte.vergleich],
     ['Ertragswert', s.verfahren.ertrag, s.gewichte.ertrag],
     ['Sachwert', s.verfahren.sach, s.gewichte.sach]].forEach(function (r) {
      var tr = t.insertRow();
      [r[0], euro(r[1]), 'Gewicht ' + Math.round(r[2] * 100) + ' %'].forEach(function (v) { tr.insertCell().textContent = v; });
    });
    if (s.abweichungHoch) {
      t.createCaption().textContent = 'Die Verfahren weichen deutlich voneinander ab – eine Vor-Ort-Bewertung ist hier besonders wichtig.';
    }
    return t;
  }

  var api = { finde: finde, schaetzen: schaetzen, euro: euro, tabelle: tabelle, PARAM: PARAM };
  root.belurWert = api;
  root.belurVerfahrenTabelle = tabelle;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
