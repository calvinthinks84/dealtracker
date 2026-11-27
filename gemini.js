exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Netlify GEMINI_API_KEY environment variable is not set.' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const prompt = body.prompt;
  if (!prompt) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing prompt' }) };
  }

  const candidates = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
  let lastError = 'No Gemini model available';

  async function tryModel(modelId) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const r1 = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }]
        })
      });
      if (r1.ok) {
        const d1 = await r1.json();
        const text = (d1?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
        if (text) return text;
      }
    } catch (e) {}

    const r2 = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    if (r2.ok) {
      const d2 = await r2.json();
      const text = d2?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (text) return text;
    }
    const errText = await r2.text().catch(() => '');
    lastError = `Gemini API error (${r2.status}): ${errText.slice(0, 140)}`;
    return null;
  }

  for (const m of candidates) {
    const text = await tryModel(m);
    if (text) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model: m })
      };
    }
  }

  return {
    statusCode: 502,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: lastError })
  };
};
