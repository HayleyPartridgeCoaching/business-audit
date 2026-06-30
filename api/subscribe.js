// Protected connector between the audit and Systeme.io.
// Runs on the server, so your API key never touches the public page.
// It creates the contact (with first name) and adds the audit-complete tag,
// which is what triggers your Audit Nurture campaign.

const SYSTEME_BASE = 'https://api.systeme.io/api';

module.exports = async (req, res) => {
  // allow the audit page to call this, even if embedded elsewhere later
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.SYSTEME_API_KEY;
  const tagName = process.env.SYSTEME_TAG_NAME || 'audit-complete';
  if (!apiKey) { res.status(500).json({ error: 'Server not configured (missing SYSTEME_API_KEY)' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const firstName = String(body.firstName || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email is required' });
    return;
  }

  const headers = {
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  try {
    const tagId = await findTagId(headers, tagName);
    if (!tagId) { res.status(500).json({ error: 'Tag not found in Systeme.io: ' + tagName }); return; }

    let contactId = await createContact(headers, email, firstName);
    if (!contactId) { contactId = await findContactId(headers, email); }
    if (!contactId) { res.status(502).json({ error: 'Could not create or locate the contact' }); return; }

    await assignTag(headers, contactId, tagId);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Upstream error', detail: String((err && err.message) || err) });
  }
};

async function findTagId(headers, name) {
  let url = SYSTEME_BASE + '/tags?limit=100';
  for (let i = 0; i < 10; i++) {
    const r = await fetch(url, { headers });
    if (!r.ok) break;
    const data = await r.json().catch(() => ({}));
    const items = data.items || data.data || (Array.isArray(data) ? data : []);
    const found = (Array.isArray(items) ? items : []).find(
      t => String(t.name || '').toLowerCase() === String(name).toLowerCase()
    );
    if (found) return found.id;
    const next = data.nextCursor || (data.meta && data.meta.nextCursor);
    if (!next) break;
    url = SYSTEME_BASE + '/tags?limit=100&startingAfter=' + encodeURIComponent(next);
  }
  return null;
}

async function createContact(headers, email, firstName) {
  const payload = { email: email };
  if (firstName) payload.fields = [{ slug: 'first_name', value: firstName }];
  const r = await fetch(SYSTEME_BASE + '/contacts', {
    method: 'POST', headers: headers, body: JSON.stringify(payload)
  });
  if (r.status === 200 || r.status === 201) {
    const data = await r.json().catch(() => ({}));
    return data.id || null;
  }
  // 409 / 422 usually means the contact already exists
  return null;
}

async function findContactId(headers, email) {
  const url = SYSTEME_BASE + '/contacts?email=' + encodeURIComponent(email);
  const r = await fetch(url, { headers });
  if (!r.ok) return null;
  const data = await r.json().catch(() => ({}));
  const items = data.items || data.data || (Array.isArray(data) ? data : []);
  if (Array.isArray(items) && items.length) return items[0].id;
  return null;
}

async function assignTag(headers, contactId, tagId) {
  const r = await fetch(SYSTEME_BASE + '/contacts/' + contactId + '/tags', {
    method: 'POST', headers: headers, body: JSON.stringify({ tagId: tagId })
  });
  return r.ok || r.status === 204; // already-tagged errors are harmless
}
