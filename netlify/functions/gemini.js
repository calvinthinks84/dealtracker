const https = require('https');

function httpsJson(url, method = 'GET', payload = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = payload ? JSON.stringify(payload) : null;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: JSON.parse(body || '{}'), raw: body });
        } catch (e) {
          resolve({ status: res.statusCode, ok: false, json: {}, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
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
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const prompt = body.prompt;
  if (!prompt) {
    return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Missing prompt' }) };
  }

  try {
    // 1) Quickly discover an active Flash model for this key (single fast call)
    let modelId = 'gemini-3.5-flash-lite';
    const listRes = await httpsJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    if (listRes.ok && Array.isArray(listRes.json.models)) {
      const available = listRes.json.models
        .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, ''))
        .filter(n => n.includes('gemini') && n.includes('flash') && !n.includes('tts') && !n.includes('image') && !n.includes('audio') && !n.includes('live'));

      const preferred = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-2.5-flash'];
      const match = preferred.find(p => available.includes(p)) || available[0];
      if (match) modelId = match;
    }

    // 2) Single fast generateContent call with Google Search grounding
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let genRes = await httpsJson(endpoint, 'POST', {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    });

    // If google_search tool isn't supported on that model, retry once without tools
    if (!genRes.ok && (genRes.status === 400 || genRes.status === 404)) {
      genRes = await httpsJson(endpoint, 'POST', {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      });
    }

    if (genRes.ok) {
      const parts = genRes.json?.candidates?.[0]?.content?.parts || [];
      const text = parts.map(p => p.text || '').join('\n').trim();
      if (text) {
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, model: modelId })
        };
      }
    }

    const errMsg = genRes.json?.error?.message || genRes.raw?.slice(0, 180) || `HTTP ${genRes.status}`;
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Gemini (${modelId}): ${errMsg}` })
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: `Function error: ${err.message}` })
    };
  }
};
