// Belur Immobilien – Lead-Verarbeitung (gemeinsam für submission-created und lead-worker-background).
//
// Umgebungsvariablen (Netlify → Site configuration → Environment variables):
//   BREVO_API_KEY        optional – ohne Key werden keine E-Mails verschickt
//   LEAD_SENDER_EMAIL    optional, Standard info@belur-immobilien.de (muss in Brevo verifiziert sein)
//   LEAD_NOTIFY_EMAIL    optional – interne Lead-Mail mit Einstufung und KI-Text an diese Adresse
//   LEAD_WEBHOOK_URL     optional – jeder Lead als JSON, z. B. an Make.com → Google Sheets
//   ANTHROPIC_API_KEY    optional – ohne Key keine KI-Ersteinschätzung (Spanne wird trotzdem berechnet)
//   BELUR_MODEL          optional, Standard claude-opus-5
import Anthropic from '@anthropic-ai/sdk';
import { getStore } from '@netlify/blobs';
import '../../../wert.js'; // klassisches Browser-Skript, setzt globalThis.belurWert
import preise from '../../../preise.json';

const wert = globalThis.belurWert;

const SITE = 'https://belur-immobilien.de';
const CALENDLY = 'https://calendly.com/ebelur/kontaktformular';
const PHONE = '0176 84143342';
const PHONE_LINK = 'tel:+4917684143342';
const MODEL = process.env.BELUR_MODEL || 'claude-opus-5';

// ─────────────────────────────── Auftrags-Speicher ─────────────────────────
const ID_RE = /^[0-9a-z]{6,12}-[0-9a-f]{32}$/;
export const store = () => getStore({ name: 'belur-leads' });
export function newId() {
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  return Date.now().toString(36) + '-' + [...rnd].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);

// ─────────────────────────────── Hilfsfunktionen ───────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());
const clean = (d) => Object.fromEntries(Object.entries(d || {}).filter(([k]) => k !== 'bot-field').map(([k, v]) => [k, String(v ?? '').slice(0, 4000)]));

/** Hot / Warm / Cold wie in der Lead-Strategie (Zeitplan + Rückrufwunsch). */
export function einstufung(form, d) {
  const z = d.zeitplan || '';
  let stufe = 'Cold';
  if (/schnell|3–6/.test(z)) stufe = 'Hot';
  else if (/6–12/.test(z)) stufe = 'Warm';
  if (form === 'kontakt' && /verkaufen|Marktwert/.test(d.anliegen || '')) stufe = 'Warm';
  if (d.rueckruf === 'ja' && stufe === 'Cold') stufe = 'Warm';
  if (d.rueckruf === 'ja' && d.dringlichkeit === 'Sofort') stufe = 'Hot';
  return stufe;
}

// ─────────────────────────────── KI-Ersteinschätzung ───────────────────────
const SYSTEM_PROMPT = `Du schreibst für Emiralp Belur, unabhängiger Immobilienmakler (Belur Immobilien, Region Stuttgart, Esslingen, Göppingen, Ostalb), eine kurze persönliche Ersteinschätzung für einen Eigentümer, der online eine Wertermittlung angefragt hat.

Vorgaben:
- Deutsch, Sie-Form, ruhig und sachlich, 130–200 Wörter, 2–3 kurze Absätze, keine Überschriften, keine Aufzählungszeichen, keine Anrede und keine Grußformel (werden ergänzt).
- Die Spanne wurde nach allen drei Verfahren der ImmoWertV ermittelt (Vergleichswert, Ertragswert, Sachwert) und nach Objektart gewichtet zusammengeführt. Du bekommst alle drei Ergebnisse, die Gewichtung und die wichtigsten Modellannahmen.
- Absatz 1: Ordne die Spanne ein und erkläre in einfachen Worten, wie die drei Verfahren zusammenspielen und warum das Verfahren mit dem höchsten Gewicht bei dieser Objektart maßgeblich ist. Liegen die Verfahren nah beieinander, sag, dass das die Einschätzung stützt; weichen sie deutlich ab (Hinweis im JSON), benenne die wahrscheinliche Ursache (z. B. Mietniveau vs. Kaufpreisniveau, Alter und Restnutzungsdauer, angenommene Grundstücksfläche).
- Absatz 2: Nenne zwei bis drei Faktoren, die bei genau diesem Objekt den tatsächlichen Wert nach oben oder unten verschieben können (z. B. energetischer Zustand und Heizung bei älteren Baujahren, tatsächliche Grundstücksgröße und Bodenrichtwertzone, Modernisierungen, Grundriss, Mikrolage). Wurde die Grundstücksfläche nur angenommen, erwähne das. Formuliere Prüfpunkte, keine Tatsachen.
- Absatz 3: Erkläre in ein bis zwei Sätzen, was eine kostenlose Vor-Ort-Bewertung zusätzlich klärt.
- Beträge nur als gerundete Werte aus dem JSON.
- Verwende ausschließlich die gelieferten Zahlen. Erfinde keine Marktdaten, Trends, Vergleichsverkäufe, Prozentwerte oder Fakten über den Ort.
- Keine Wertgarantie, keine Rechts- oder Steuerberatung, keine Superlative, keine Verkaufsdruck-Formulierungen.
- Wenn die Angaben widersprüchlich oder ungewöhnlich wirken, sage das neutral und verweise auf die Vor-Ort-Bewertung.`;

export async function kiEinschaetzung(d, s) {
  if (!process.env.ANTHROPIC_API_KEY || !s.ok) return null;
  const a = s.annahmen;
  const angaben = {
    objektart: d.objektart, wohnflaeche: d.wohnflaeche, grundstueck: d.grundstueck || null, garage_stellplatz: d.garage || null, zimmer: d.zimmer || null,
    baujahr: d.baujahr || null, zustand: d.zustand || null, lage: d.lage || null, zeitplan: d.zeitplan || null,
    gebiet: s.gebiet, datenbasis: s.basis === 'gemeinde' ? 'Durchschnitt der Gemeinde' : 'Durchschnitt des Landkreises (keine Gemeindedaten)',
    spanne: `${wert.euro(s.von)} – ${wert.euro(s.bis)}`, marktwert_gewichtet: wert.euro(s.wert),
    vergleichswert: { ergebnis: wert.euro(s.verfahren.vergleich), gewicht: s.gewichte.vergleich, angepasster_preis_pro_qm: `${a.vergleichQm} €` },
    ertragswert: { ergebnis: wert.euro(s.verfahren.ertrag), gewicht: s.gewichte.ertrag, miete_pro_qm: `${a.miete} €`,
      miete_garage_stellplatz_monat: a.mieteStellplaetze ? `${a.mieteStellplaetze} €` : null, rohertrag_jahr: wert.euro(a.rohertrag),
      bewirtschaftungskosten: `${Math.round(a.bwkSatz * 100)} %`, liegenschaftszins: `${(a.liegenschaftszins * 100).toFixed(1)} %`,
      restnutzungsdauer_jahre: a.restnutzungsdauer, vervielfaeltiger: a.vervielfaeltiger },
    sachwert: { ergebnis: wert.euro(s.verfahren.sach), gewicht: s.gewichte.sach, herstellungskosten_pro_qm: `${a.herstellungskosten} €`,
      alterswertminderung: `${a.alterswertminderung} %`, marktanpassungsfaktor: a.sachwertfaktor },
    bodenwert: { bodenrichtwert_pro_qm: `${a.bodenrichtwert} €`, grundstueck_qm: a.grundstueck,
      grundstueck_nur_angenommen: a.grundstueckAngenommen, bodenrichtwert_geschaetzt: s.brwBasis !== 'gemeinde' },
    verfahren_weichen_deutlich_ab: s.abweichungHoch, datenstand: s.stand,
  };
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  const params = {
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Angaben und Berechnung (JSON):\n${JSON.stringify(angaben, null, 2)}` }],
  };
  let message;
  try {
    // Serverseitiger Fallback auf ein anderes Modell, falls das Hauptmodell ablehnt (wie bei GuardAI)
    message = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (!(err instanceof Anthropic.BadRequestError)) throw err;
    message = await client.messages.create(params);
  }
  if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
    console.warn('KI-Einschätzung nicht verwendbar:', message.stop_reason);
    return null;
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return text || null;
}

// ─────────────────────────────── Versand ───────────────────────────────────
async function brevo(to, subject, html, tag, replyTo) {
  const key = process.env.BREVO_API_KEY;
  if (!key) return false;
  const sender = process.env.LEAD_SENDER_EMAIL || 'info@belur-immobilien.de';
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Belur Immobilien', email: sender },
      replyTo: replyTo || { name: 'Emiralp Belur', email: sender },
      to: [to], subject, htmlContent: html, tags: [tag],
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
  return true;
}

async function webhook(payload) {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) return;
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Webhook ${res.status}`);
}

/**
 * Verarbeitet einen gespeicherten Lead vollständig.
 * @param lead  { form, data, created_at }
 * @param opts  { ki: boolean } – false, wenn keine Zeit für den KI-Aufruf ist (synchroner Notfallpfad)
 */
export async function verarbeite(lead, { ki = true } = {}) {
  const form = lead.form;
  const d = clean(lead.data);
  const isBewertung = form === 'bewertung';
  const stufe = einstufung(form, d);
  const schaetzung = isBewertung ? wert.schaetzen(preise, d) : null;

  let text = null;
  if (ki && schaetzung?.ok) {
    try { text = await kiEinschaetzung(d, schaetzung); }
    catch (err) { console.error('KI-Einschätzung fehlgeschlagen:', err?.status || '', err?.message || err); }
  }

  const jobs = [];
  if (validEmail(d.email)) {
    const name = [d.vorname, d.nachname].filter(Boolean).join(' ') || d.email;
    jobs.push(['Bestätigungsmail', brevo(
      { email: d.email.trim(), name },
      isBewertung ? 'Ihre Bewertungsanfrage bei Belur Immobilien' : 'Ihre Anfrage bei Belur Immobilien',
      bestaetigungHtml(d, isBewertung, schaetzung, text), `lead-${form}`,
    )]);
  }
  if (process.env.LEAD_NOTIFY_EMAIL) {
    jobs.push(['Interne Lead-Mail', brevo(
      { email: process.env.LEAD_NOTIFY_EMAIL, name: 'Belur Immobilien' },
      interneBetreff(form, d, stufe), internHtml(form, d, stufe, schaetzung, text), 'lead-intern',
      validEmail(d.email) ? { email: d.email.trim(), name: d.vorname || d.email } : undefined,
    )]);
  }
  jobs.push(['Webhook', webhook({
    formular: form, eingang: lead.created_at, einstufung: stufe, ...d,
    spanne_von: schaetzung?.ok ? schaetzung.von : '', spanne_bis: schaetzung?.ok ? schaetzung.bis : '',
    vergleichswert: schaetzung?.ok ? schaetzung.verfahren.vergleich : '', ertragswert: schaetzung?.ok ? schaetzung.verfahren.ertrag : '',
    sachwert: schaetzung?.ok ? schaetzung.verfahren.sach : '',
    gebiet: schaetzung?.ok ? schaetzung.gebiet : '', ki_einschaetzung: text || '',
  })]);

  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  results.forEach((r, i) => { if (r.status === 'rejected') console.error(jobs[i][0], 'fehlgeschlagen:', r.reason); });
}

// ─────────────────────────────── E-Mail-Inhalte ────────────────────────────
function zeilen(rows) {
  return rows
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #E6E1D6;font-size:13px;color:#7A7F8A;width:42%;vertical-align:top">${esc(k)}</td>
      <td style="padding:8px 0;border-bottom:1px solid #E6E1D6;font-size:14px;color:#0B1526;vertical-align:top">${esc(v).replace(/\n/g, '<br>')}</td>
    </tr>`).join('');
}

function angabenRows(d, isBewertung) {
  const rows = isBewertung
    ? [['Objektart', d.objektart], ['Wohnfläche', d.wohnflaeche], ['Grundstück', d.grundstueck], ['Garage / Stellplatz', d.garage], ['Zimmer', d.zimmer], ['Baujahr', d.baujahr],
       ['Zustand', d.zustand], ['Lage', d.lage], ['Ort', [d.plz, d.ort].filter(Boolean).join(' ')], ['Zeitplan', d.zeitplan]]
    : [['Anliegen', d.anliegen], ['Dringlichkeit', d.dringlichkeit], ['Nachricht', d.nachricht]];
  rows.push(['Rückruf gewünscht', d.rueckruf === 'ja' ? 'Ja' + (d.telefon ? ` (${d.telefon})` : '') : 'Nein']);
  return rows;
}

function absaetze(text) {
  return String(text).split(/\n\s*\n/).map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#3A4150">${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
}

function einschaetzungBlock(s, text) {
  if (!s) return '';
  if (!s.ok) {
    const warum = s.grund === 'grundstueck'
      ? 'Grundstücke bewerten wir individuell anhand des Bodenrichtwerts und der Bebaubarkeit.'
      : s.grund === 'region'
        ? 'Für Ihre Postleitzahl liegen uns noch keine hinterlegten Vergleichsdaten vor. Wir bewerten Ihre Immobilie deshalb individuell.'
        : 'Für eine erste Spanne fehlen noch Angaben. Wir bewerten Ihre Immobilie individuell.';
    return `<p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#3A4150">${warum}</p>`;
  }
  return `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;background-color:#F7F4EC;border-left:3px solid #C4A86B">
      <tr><td style="padding:20px 22px">
        <p style="margin:0 0 6px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#A8884E">Ihre Ersteinschätzung</p>
        <p style="margin:0 0 4px;font-family:Georgia,serif;font-size:24px;color:#0B1526">${esc(wert.euro(s.von))} – ${esc(wert.euro(s.bis))}</p>
        <p style="margin:0 0 12px;font-size:12px;line-height:1.6;color:#7A7F8A">Gebiet: ${esc(s.gebiet)} · ermittelt nach allen drei Verfahren der ImmoWertV, gewichtet nach Objektart</p>
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 ${text ? '16px' : '4px'}">
          ${[['Vergleichswert', s.verfahren.vergleich, s.gewichte.vergleich], ['Ertragswert', s.verfahren.ertrag, s.gewichte.ertrag], ['Sachwert', s.verfahren.sach, s.gewichte.sach]]
            .map(([n, v, g]) => `<tr>
              <td style="padding:6px 0;border-bottom:1px solid #E6E1D6;font-size:13px;color:#3A4150">${n}</td>
              <td style="padding:6px 0;border-bottom:1px solid #E6E1D6;font-size:14px;color:#0B1526;text-align:right">${esc(wert.euro(v))}</td>
              <td style="padding:6px 0 6px 12px;border-bottom:1px solid #E6E1D6;font-size:12px;color:#7A7F8A;text-align:right;white-space:nowrap">Gewicht ${Math.round(g * 100)} %</td>
            </tr>`).join('')}
        </table>
        ${text ? absaetze(text) : ''}
        <p style="margin:4px 0 0;font-size:11px;line-height:1.6;color:#8A8F99">Unverbindliche, automatisiert erstellte Orientierung auf Basis Ihrer Online-Angaben – kein Wertgutachten. Angebotspreise können von erzielten Verkaufspreisen abweichen.</p>
      </td></tr>
    </table>`;
}

function rahmen(inhalt) {
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Belur Immobilien</title></head>
<body style="margin:0;padding:0;background-color:#F4F1EA;font-family:Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F1EA;padding:36px 16px">
  <tr><td align="center">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
      <tr><td align="center" style="padding-bottom:24px">
        <span style="font-family:Georgia,serif;font-size:22px;letter-spacing:.14em;color:#0B1526">BELUR</span>
        <span style="font-size:11px;letter-spacing:.32em;color:#A8884E;padding-left:6px">IMMOBILIEN</span>
      </td></tr>
      <tr><td style="background-color:#FFFFFF;border:1px solid #E6E1D6">
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background-color:#C4A86B;height:3px;font-size:0;line-height:0">&nbsp;</td></tr></table>
        <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:36px 36px 28px">${inhalt}</td></tr></table>
      </td></tr>
      <tr><td style="padding-top:22px;text-align:center">
        <p style="margin:0 0 6px;font-size:11px;line-height:1.6;color:#8A8F99">
          Sie erhalten diese E-Mail, weil auf belur-immobilien.de eine Anfrage mit Ihrer Adresse gesendet wurde.
          Falls das nicht Sie waren, können Sie diese Nachricht ignorieren.
        </p>
        <p style="margin:0;font-size:11px;line-height:1.6;color:#8A8F99">
          Belur Immobilien · Emiralp Belur · Rebhuhnweg 11, 73529 Schwäbisch Gmünd<br>
          <a href="${SITE}/belur-impressum.html" style="color:#8A8F99">Impressum</a> ·
          <a href="${SITE}/belur-datenschutz.html" style="color:#8A8F99">Datenschutz</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function bestaetigungHtml(d, isBewertung, schaetzung, text) {
  const name = String(d.vorname || '').trim();
  const intro = isBewertung
    ? 'vielen Dank für Ihre Bewertungsanfrage. Ich sehe mir Ihre Angaben persönlich an und melde mich innerhalb von 24 Stunden (werktags) mit dem Angebot einer kostenlosen Vor-Ort-Bewertung.'
    : 'vielen Dank für Ihre Nachricht. Ich melde mich innerhalb von 24 Stunden (werktags) persönlich bei Ihnen.';
  return rahmen(`
    <h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:24px;font-weight:normal;line-height:1.25;color:#0B1526">
      ${isBewertung ? 'Ihre Bewertungsanfrage ist eingegangen' : 'Ihre Anfrage ist eingegangen'}
    </h1>
    <p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#3A4150">${name ? `Guten Tag ${esc(name)},` : 'Guten Tag,'}</p>
    <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#3A4150">${intro}</p>
    ${isBewertung ? einschaetzungBlock(schaetzung, text) : ''}
    <p style="margin:0 0 8px;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#A8884E">Ihre Angaben</p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px">${zeilen(angabenRows(d, isBewertung))}</table>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#3A4150">Wenn es schneller gehen soll, buchen Sie gern direkt einen Termin oder rufen Sie mich an.</p>
    <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:12px"><tr>
      <td style="background-color:#0B1526"><a href="${CALENDLY}" style="display:inline-block;padding:13px 26px;font-size:14px;color:#FFFFFF;text-decoration:none;letter-spacing:.02em">Termin buchen →</a></td>
    </tr></table>
    <p style="margin:0 0 28px;font-size:14px;color:#3A4150">oder telefonisch: <a href="${PHONE_LINK}" style="color:#0B1526;font-weight:bold;text-decoration:none">${PHONE}</a></p>
    <p style="margin:0;font-size:15px;line-height:1.7;color:#3A4150">Freundliche Grüße<br><strong style="color:#0B1526">Emiralp Belur</strong><br><span style="font-size:13px;color:#7A7F8A">Immobilienmakler · Belur Immobilien</span></p>`);
}

function interneBetreff(form, d, stufe) {
  const wer = [d.vorname, d.nachname].filter(Boolean).join(' ') || d.email || 'unbekannt';
  const was = form === 'bewertung'
    ? `Bewertung: ${d.objektart || '?'}, ${d.wohnflaeche || '?'}, ${[d.plz, d.ort].filter(Boolean).join(' ')}`
    : `Kontakt: ${d.anliegen || 'Anfrage'}`;
  return `[${stufe}] ${was} – ${wer}`;
}

function internHtml(form, d, stufe, schaetzung, text) {
  const farbe = { Hot: '#A12A2A', Warm: '#8F5F12', Cold: '#3A4150' }[stufe];
  const kontakt = [['Name', [d.vorname, d.nachname].filter(Boolean).join(' ')], ['E-Mail', d.email], ['Telefon', d.telefon],
    ['Rückruf gewünscht', d.rueckruf === 'ja' ? 'JA' : 'nein'], ['Quelle', `${d.quelle || form} (${d.seite || ''})`], ['Kampagne', d.kampagne]];
  return rahmen(`
    <p style="margin:0 0 6px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:${farbe};font-weight:bold">${stufe}-Lead · ${form === 'bewertung' ? 'Bewertung' : 'Kontakt'}</p>
    <h1 style="margin:0 0 18px;font-family:Georgia,serif;font-size:22px;font-weight:normal;color:#0B1526">${esc(interneBetreff(form, d, stufe).replace(/^\[\w+\] /, ''))}</h1>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#3A4150">Ziel: Antwort innerhalb 1 Stunde. ${d.rueckruf === 'ja' ? 'Rückruf ist ausdrücklich gewünscht.' : 'Kein Rückrufwunsch – per E-Mail antworten.'}</p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:24px">${zeilen(kontakt)}</table>
    ${form === 'bewertung' ? einschaetzungBlock(schaetzung, text) : ''}
    <table width="100%" cellpadding="0" cellspacing="0" border="0">${zeilen(angabenRows(d, form === 'bewertung'))}</table>`);
}
