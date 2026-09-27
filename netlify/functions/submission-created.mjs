// Belur Immobilien – läuft automatisch nach jeder (nicht als Spam markierten) Netlify-Forms-Einsendung.
// Der Lead ist zu diesem Zeitpunkt bereits bei Netlify gespeichert. Diese Function legt ihn als Auftrag
// in Netlify Blobs ab und startet den Hintergrund-Worker (Werteinschätzung + KI-Text + E-Mails + Webhook).
// Der Worker verarbeitet nur Aufträge, die hier abgelegt wurden – von außen lässt sich nichts einschleusen.
// Fällt Blobs oder der Worker-Start aus, wird direkt ohne KI-Text verarbeitet, damit Bestätigung und Info trotzdem rausgehen.
import { connectLambda } from '@netlify/blobs';
import { store, newId, verarbeite } from './lib/lead.mjs';

export const handler = async (event) => {
  let payload;
  try {
    payload = JSON.parse(event.body).payload;
  } catch {
    return { statusCode: 400, body: 'invalid payload' };
  }
  if (!['bewertung', 'kontakt'].includes(payload.form_name)) return { statusCode: 200, body: 'ignored' };
  const lead = { form: payload.form_name, data: payload.data || {}, created_at: payload.created_at };

  try {
    connectLambda(event);
    const id = newId();
    await store().setJSON(`lead/${id}`, lead);
    const base = process.env.URL || 'https://belur-immobilien.de';
    const res = await fetch(`${base}/.netlify/functions/lead-worker-background`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.status !== 202 && !res.ok) throw new Error(`Worker-Start ${res.status}`);
    return { statusCode: 200, body: 'queued' };
  } catch (err) {
    console.error('Hintergrundverarbeitung nicht möglich, verarbeite direkt ohne KI:', err);
    await verarbeite(lead, { ki: false });
    return { statusCode: 200, body: 'ok' };
  }
};
