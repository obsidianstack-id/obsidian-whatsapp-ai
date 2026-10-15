const { getSettings, db } = require('../database/db');

function businessContext() {
  const settings = getSettings();
  const products = db
    .prepare(
      `SELECT sku, name, category, description, price, promo_price, stock, unlimited_stock
       FROM products WHERE active = 1 ORDER BY name LIMIT 100`,
    )
    .all();

  return [
    `Business: ${settings.business_name}`,
    `Description: ${settings.business_description}`,
    `Hours: ${settings.business_hours}`,
    `Products: ${JSON.stringify(products)}`,
    `Currency: ${settings.currency || 'IDR'}`,
  ].join('\n');
}

async function askOpenRouter(waId, question) {
  const settings = getSettings();
  if (settings.ai_enabled !== '1') return null;

  if (!settings.openrouter_api_key) {
    return 'Maaf, fitur AI belum dikonfigurasi. Kamu bisa mengetik *menu* atau meminta bantuan customer service.';
  }

  const history = db
    .prepare(
      `SELECT direction, body FROM messages
       WHERE wa_id = ? ORDER BY id DESC LIMIT 12`,
    )
    .all(waId)
    .reverse();

  // The incoming message is recorded before AI is called. Do not append it twice.
  if (history.at(-1)?.direction === 'in' && history.at(-1)?.body === question) {
    history.pop();
  }

  const systemPrompt = [
    settings.ai_system_prompt,
    'Informasi bisnis terkini (gunakan sebagai sumber fakta):',
    businessContext(),
    'Aturan: jangan menyatakan pembayaran lunas kecuali sistem menyatakan terverifikasi.',
    'Jika pelanggan ingin berbicara dengan manusia, minta mereka mengetik CS.',
  ].join('\n\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map((message) => ({
      role: message.direction === 'out' ? 'assistant' : 'user',
      content: message.body,
    })),
    { role: 'user', content: question },
  ];

  const headers = {
    Authorization: `Bearer ${settings.openrouter_api_key}`,
    'Content-Type': 'application/json',
    'X-Title': settings.openrouter_app_name || 'WhatsApp AI',
  };
  if (settings.openrouter_site_url) {
    headers['HTTP-Referer'] = settings.openrouter_site_url;
  }

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.openrouter_model || 'meta-llama/llama-3.3-70b-instruct:free',
      messages,
      temperature: 0.4,
      max_tokens: 500,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || `OpenRouter HTTP ${response.status}`);
  }

  return data?.choices?.[0]?.message?.content?.trim() || null;
}

module.exports = { askOpenRouter };
