// ============================================================
// Servidor de traqueamento
// - Serve a pagina de vendas estatica (pasta /public)
// - Injeta os IDs publicos (Pixel, GA4) via /tracking-config.js
// - Recebe eventos do browser e repassa para a Conversions API (CAPI)
//   da Meta, com hashing SHA-256 dos dados pessoais e deduplicacao.
// ============================================================

import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  META_PIXEL_ID = '',
  META_CAPI_ACCESS_TOKEN = '',
  META_GRAPH_API_VERSION = 'v21.0',
  META_TEST_EVENT_CODE = '',
  GA4_MEASUREMENT_ID = '',
  PORT = 3000,
} = process.env;

const app = express();
app.use(express.json({ limit: '256kb' }));
// Necessario para capturar o IP real do cliente atras de proxy/CDN.
app.set('trust proxy', true);

// --- Helpers -------------------------------------------------

// A Meta exige que dados pessoais (PII) sejam normalizados e
// enviados como hash SHA-256. Nunca enviar em texto puro.
function sha256(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return undefined;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// Telefone: so digitos, com DDI. Email: minusculo sem espacos.
function normalizePhone(phone) {
  if (!phone) return undefined;
  return String(phone).replace(/[^0-9]/g, '');
}

// Monta o objeto user_data exigido pela CAPI, ja com hash.
function buildUserData(req, raw = {}) {
  const userData = {
    client_ip_address: req.ip,
    client_user_agent: req.get('user-agent'),
  };

  if (raw.em) userData.em = [sha256(raw.em)];
  if (raw.ph) userData.ph = [sha256(normalizePhone(raw.ph))];
  if (raw.fn) userData.fn = [sha256(raw.fn)];
  if (raw.ln) userData.ln = [sha256(raw.ln)];
  if (raw.ct) userData.ct = [sha256(raw.ct)];
  if (raw.st) userData.st = [sha256(raw.st)];
  if (raw.zp) userData.zp = [sha256(raw.zp)];
  if (raw.country) userData.country = [sha256(raw.country)];

  // fbp/fbc nao sao hasheados (cookies do proprio Pixel).
  if (raw.fbp) userData.fbp = raw.fbp;
  if (raw.fbc) userData.fbc = raw.fbc;

  return userData;
}

// --- Config publica para o browser ---------------------------
// Centraliza os IDs num unico lugar (vindos do .env) e entrega
// pro front. Apenas dados PUBLICOS (Pixel ID e GA4 ID). O token
// da CAPI nunca sai do servidor.
app.get('/tracking-config.js', (_req, res) => {
  const config = {
    metaPixelId: META_PIXEL_ID,
    ga4MeasurementId: GA4_MEASUREMENT_ID,
    capiEndpoint: '/api/track',
  };
  res.type('application/javascript');
  res.send(`window.TRACKING_CONFIG = ${JSON.stringify(config)};`);
});

// --- Endpoint da Conversions API -----------------------------
app.post('/api/track', async (req, res) => {
  if (!META_PIXEL_ID || !META_CAPI_ACCESS_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: 'CAPI nao configurada (defina META_PIXEL_ID e META_CAPI_ACCESS_TOKEN no .env).',
    });
  }

  try {
    const body = req.body || {};
    const {
      event_name,
      event_id,
      event_source_url,
      action_source = 'website',
      custom_data = {},
      user_data: rawUserData = {},
    } = body;

    if (!event_name) {
      return res.status(400).json({ ok: false, error: 'event_name e obrigatorio.' });
    }

    const event = {
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      // O mesmo event_id usado no Pixel do browser -> deduplicacao.
      event_id,
      event_source_url,
      action_source,
      user_data: buildUserData(req, rawUserData),
      custom_data,
    };

    const payload = { data: [event] };
    if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;

    const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${META_PIXEL_ID}/events?access_token=${encodeURIComponent(
      META_CAPI_ACCESS_TOKEN,
    )}`;

    const fbRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // A Meta normalmente responde JSON, mas em erros de rede/proxy pode vir
    // texto puro. Lemos como texto e tentamos converter sem quebrar.
    const rawText = await fbRes.text();
    let result;
    try {
      result = JSON.parse(rawText);
    } catch {
      result = { raw: rawText };
    }

    if (!fbRes.ok) {
      console.error('[CAPI] Erro da Meta:', rawText);
      return res.status(502).json({ ok: false, error: result });
    }

    return res.json({ ok: true, event_name, event_id, fb: result });
  } catch (err) {
    console.error('[CAPI] Falha ao enviar evento:', err);
    return res.status(500).json({ ok: false, error: 'Falha interna ao enviar evento.' });
  }
});

// --- Arquivos estaticos (a pagina de vendas) -----------------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`\n  Servidor de traqueamento rodando em http://localhost:${PORT}`);
  console.log(`  Pixel: ${META_PIXEL_ID || '(nao configurado)'}  |  GA4: ${GA4_MEASUREMENT_ID || '(nao configurado)'}`);
  console.log(`  CAPI: ${META_CAPI_ACCESS_TOKEN ? 'ativa' : 'INATIVA (configure o token)'}\n`);
});
