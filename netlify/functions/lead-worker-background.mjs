// Hintergrund-Worker (bis zu 15 Minuten): Werteinschätzung, KI-Ersteinschätzung, E-Mails, Webhook.
// POST /.netlify/functions/lead-worker-background  { id }  → sofort 202
// Wird nur von submission-created aufgerufen; unbekannte oder bereits verarbeitete IDs werden ignoriert.
import { store, isValidId, verarbeite } from './lib/lead.mjs';

export default async function handler(req) {
  let id;
  try { ({ id } = await req.json()); } catch { return; }
  if (!isValidId(id)) return;

  const s = store();
  const lead = await s.get(`lead/${id}`, { type: 'json' });
  if (!lead) return; // unbekannt oder bereits verarbeitet (z. B. doppelter Aufruf)
  await s.delete(`lead/${id}`); // Kontaktdaten nicht länger als nötig zwischenspeichern

  try {
    await verarbeite(lead, { ki: true });
  } catch (err) {
    console.error('Lead-Verarbeitung fehlgeschlagen', err);
  }
}
