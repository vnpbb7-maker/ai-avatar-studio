/* ============================================================
   v3/server.js — Proxy + fal.ai REST API handler
   使用エンドポイント:
     rest.fal.ai  →  storage upload initiate + queue submit/status
     api.elevenlabs.io → TTS
     localhost:50021   → VOICEVOX
============================================================ */
'use strict';
const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
const url   = require('url');

process.on('uncaughtException', err => console.error('Uncaught:', err.message));

const PORT    = 3001;
const EL_HOST = 'api.elevenlabs.io';
const VV_PORT = 50021;
const FAL_REST = 'rest.fal.ai';   // ← 正しいホスト
const FAL_Q    = 'queue.fal.run';

const MIME = {
  '.html':'text/html','.js':'application/javascript','.css':'text/css',
  '.json':'application/json','.mp4':'video/mp4','.mp3':'audio/mpeg',
  '.wav':'audio/wav','.png':'image/png','.jpg':'image/jpeg',
  '.webp':'image/webp','.ico':'image/x-icon',
};

/* ── HTTPS helper ────────────────────────────────────────────── */
function httpsPost(hostname, path, headers, bodyBuf, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname, path, method: 'POST', headers: {
        ...headers, 'Content-Length': bodyBuf.length,
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('HTTPS timeout')); });
    req.write(bodyBuf);
    req.end();
  });
}

function httpsPut(putUrl, contentType, fileBuf, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const u = new URL(putUrl);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileBuf.length,
      },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`PUT timeout after ${timeoutMs/1000}s`)); });
    // チャンク分割で送信（大ファイル対策）
    const CHUNK = 256 * 1024; // 256KB
    let offset = 0;
    function writeNext() {
      if (offset >= fileBuf.length) { req.end(); return; }
      const slice = fileBuf.slice(offset, offset + CHUNK);
      offset += slice.length;
      const ok = req.write(slice);
      if (ok) { writeNext(); } else { req.once('drain', writeNext); }
    }
    writeNext();
  });
}

function httpsGet(hostname, path, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method: 'GET', headers };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('GET timeout')); });
    req.end();
  });
}

/* ── fal.ai ファイルアップロード（リトライ付き） ────────────── */
async function uploadToFal(fileBuf, fileName, contentType, apiKey) {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // 1. アップロードURLを取得（リトライごとに新規取得）
      const initBody = Buffer.from(JSON.stringify({ file_name: fileName, content_type: contentType }));
      const initRes = await httpsPost(FAL_REST, '/storage/upload/initiate?storage_type=fal-cdn-v3', {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json',
      }, initBody, 30000);

      console.log(`[upload initiate][${attempt}] ${initRes.status} ${initRes.body.slice(0,200)}`);
      if (initRes.status !== 200) throw new Error(`upload initiate失敗 (${initRes.status}): ${initRes.body.slice(0,200)}`);

      const { upload_url, file_url } = JSON.parse(initRes.body);
      if (!upload_url || !file_url) throw new Error(`upload URLなし: ${initRes.body}`);

      // 2. ファイルをアップロード
      console.log(`[upload PUT][${attempt}] ${fileName} ${(fileBuf.length/1024).toFixed(0)}KB → ${upload_url.slice(0,60)}...`);
      const putRes = await httpsPut(upload_url, contentType, fileBuf, 180000);
      console.log(`[upload PUT][${attempt}] status=${putRes.status}`);

      if (putRes.status >= 200 && putRes.status < 300) {
        console.log(`[upload] 成功: ${file_url.slice(0,80)}`);
        return file_url;
      }

      // 408(タイムアウト) / 503(一時エラー) はリトライ
      if ((putRes.status === 408 || putRes.status === 503) && attempt < MAX_ATTEMPTS) {
        const wait = attempt * 2000;
        console.warn(`[upload PUT][${attempt}] ${putRes.status} — ${wait/1000}秒後にリトライ (initiate URL再取得)`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw new Error(`upload PUT失敗 (${putRes.status}): ${putRes.body.slice(0,100)}`);

    } catch(e) {
      if (attempt < MAX_ATTEMPTS && (e.message.includes('timeout') || e.message.includes('ECONNRESET'))) {
        const wait = attempt * 2000;
        console.warn(`[upload][${attempt}] 通信エラー、${wait/1000}秒後リトライ: ${e.message}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`upload失敗: ${MAX_ATTEMPTS}回試行が全て失敗`);
}

/* ── JSON ユーティリティ ────────────────────────────────────── */
function readJsonBody(req, maxMB = 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if(size > maxMB*1024*1024) reject(new Error('body too large')); else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(e); } });
  });
}

function jsonRes(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(body);
}

/* ── 汎用プロキシ ─────────────────────────────────────────── */
const MAX_BODY = 10 * 1024 * 1024; // 10MB

function proxyRequest(req, res, targetHost, targetPath, useHttp = false) {
  const chunks = [];
  let bodySize = 0;
  const proto = useHttp ? http : https;
  const port  = useHttp ? VV_PORT : 443;

  req.on('data', c => {
    bodySize += c.length;
    if (bodySize > MAX_BODY) { res.writeHead(413); res.end('too large'); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.destroyed || res.headersSent) return;
    const data = Buffer.concat(chunks);
    const headers = { ...req.headers };
    delete headers['host']; delete headers['connection'];
    headers['content-length'] = data.length;
    const opts = { hostname: targetHost, port, path: targetPath, method: req.method, headers, timeout: 30000 };
    const proxy = proto.request(opts, pRes => {
      res.writeHead(pRes.statusCode, {
        ...pRes.headers,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization,Accept,X-Api-Key,X-Fal-Key,X-Fal-Model,X-Fal-Status-Url,X-Fal-Response-Url',
      });
      pRes.pipe(res);
    });
    proxy.on('error', err => { console.error(`Proxy error:`, err.message); if(!res.headersSent) res.writeHead(502); res.end(JSON.stringify({error:err.message})); });
    proxy.on('timeout', () => { proxy.destroy(); if(!res.headersSent) res.writeHead(504); res.end(JSON.stringify({error:'timeout'})); });
    if (data.length) proxy.write(data);
    proxy.end();
  });
}

/* ── サーバー ───────────────────────────────────────────────── */
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization,Accept,X-Api-Key,X-Fal-Key,X-Fal-Model,X-Fal-Status-Url,X-Fal-Response-Url',
    });
    return res.end();
  }

  const parsedUrl = url.parse(req.url);
  const pathname  = decodeURIComponent(parsedUrl.pathname);

  /* ── /api/generate → アップロード + SadTalker送信 ── */
  if (pathname === '/api/generate' && req.method === 'POST') {
    (async () => {
      try {
        const body = await readJsonBody(req);
        const { falKey, imageDataUrl, audioDataUrl, options } = body;
        if (!falKey || !imageDataUrl || !audioDataUrl)
          return jsonRes(res, 400, { error: '必須項目が不足しています' });

        console.log('[API] ファイルアップロード開始...');

        const imgBuf = Buffer.from(imageDataUrl.split(',')[1], 'base64');
        const audMime = audioDataUrl.split(';')[0].split(':')[1] || 'audio/wav';
        const audExt  = audMime.includes('webm') ? 'webm' : 'wav';
        const audBuf  = Buffer.from(audioDataUrl.split(',')[1], 'base64');

        // シリアル実行（並列だと帯域競合で408が増える）
        console.log(`[API] 画像アップロード中... (${(imgBuf.length/1024).toFixed(0)}KB)`);
        const imageUrl = await uploadToFal(imgBuf, 'image.jpg', 'image/jpeg', falKey);
        console.log('[API] 画像URL:', imageUrl);

        console.log(`[API] 音声アップロード中... (${(audBuf.length/1024).toFixed(0)}KB)`);
        const audioUrl = await uploadToFal(audBuf, `audio.${audExt}`, audMime, falKey);
        console.log('[API] 音声URL:', audioUrl);

        // ── OmniHuman v1.5: 全身アニメーション（顔+体+ジェスチャー）──
        const modelEndpoint = '/fal-ai/bytedance/omnihuman/v1.5';
        const modelPath     = 'fal-ai/bytedance/omnihuman/v1.5';
        const omniInput = {
          image_url:   imageUrl,
          audio_url:   audioUrl,
          resolution:  options?.resolution === '512' ? '1080p' : '720p',
          turbo_mode:  false,
          prompt:      options?.prompt || null,
        };
        console.log(`[API] OmniHuman params: resolution=${omniInput.resolution} turbo=${omniInput.turbo_mode}`);
        const qBody = Buffer.from(JSON.stringify(omniInput));

        console.log('[API] OmniHuman Queue送信中...');
        let qRes;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            console.log(`[API] OmniHuman Queue 試行 ${attempt}...`);
            qRes = await httpsPost(FAL_Q, modelEndpoint, {
              'Authorization': `Key ${falKey}`,
              'Content-Type':  'application/json',
            }, qBody, 60000);
            console.log(`[API] OmniHuman Queue ${qRes.status}: ${qRes.body.slice(0, 200)}`);
            break;
          } catch(e) {
            console.error(`[API] OmniHuman Queue 試行${attempt} 失敗:`, e.message);
            if (attempt === 2) throw new Error(`OmniHuman Queue送信失敗: ${e.message}`);
            await new Promise(r => setTimeout(r, 3000));
          }
        }

        if (qRes.status >= 400) {
          console.error('[API] OmniHuman送信失敗レスポンス:', qRes.body.slice(0, 500));
          throw new Error(`OmniHuman送信失敗 (${qRes.status}): ${qRes.body.slice(0, 300)}`);
        }

        let qData;
        try { qData = JSON.parse(qRes.body); } catch(e) {
          throw new Error(`OmniHumanレスポンスJSONパース失敗: ${qRes.body.slice(0,200)}`);
        }
        if (!qData.request_id) {
          throw new Error(`OmniHuman request_id なし: ${JSON.stringify(qData).slice(0,200)}`);
        }
        console.log('[API] OmniHuman request_id:', qData.request_id);
        console.log('[API] queue response keys:', Object.keys(qData).join(', '));
        // status_url / response_url があればクライアントに渡す
        jsonRes(res, 200, {
          request_id:   qData.request_id,
          modelPath,
          status_url:   qData.status_url   || null,
          response_url: qData.response_url || null,
        });

      } catch(err) {
        console.error('[API] エラー:', err.message);
        jsonRes(res, 500, { error: err.message });
      }
    })();
    return;
  }

  /* ── /api/status/:id → ステータス確認（高速版） ── */
  if (pathname.startsWith('/api/status/') && req.method === 'GET') {
    (async () => {
      const handlerStart = Date.now();
      try {
        const requestId = pathname.replace('/api/status/', '').split('?')[0];
        const qp = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        const apiKey      = (qp.get('key')          || req.headers['x-fal-key']          || '').replace(/[^\x20-\x7E]/g,'').trim();
        const modelPath   = (qp.get('model')        || req.headers['x-fal-model']        || 'fal-ai/bytedance/omnihuman/v1.5').trim();
        const statusUrl   = (qp.get('status_url')   || req.headers['x-fal-status-url']   || '').trim();
        const responseUrl = (qp.get('response_url') || req.headers['x-fal-response-url'] || '').trim();
        if (!apiKey) return jsonRes(res, 200, { status: 'ERROR', error: 'APIキーなし' });

        const authHeader = { 'Authorization': `Key ${apiKey}` };
        const FAST_TIMEOUT = 8000; // 各リクエスト最大8秒

        /* ── ヘルパー: 再帰的に動画URLを探索 ── */
        function deepFindVideoUrl(obj, depth) {
          if (!obj || typeof obj !== 'object' || (depth || 0) > 4) return null;
          if (typeof obj.url === 'string' && /\.(mp4|webm)|fal\.media|fal-cdn|fal\.run|v3\.fal/.test(obj.url)) return obj.url;
          if (obj.video && typeof obj.video === 'string' && /\.(mp4|webm)|fal/.test(obj.video)) return obj.video;
          if (obj.video && typeof obj.video === 'object' && typeof obj.video.url === 'string') return obj.video.url;
          for (const key of ['result', 'output', 'data']) {
            if (obj[key]) {
              const found = deepFindVideoUrl(obj[key], (depth||0)+1);
              if (found) return found;
            }
          }
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const found = deepFindVideoUrl(item, (depth||0)+1);
              if (found) return found;
            }
          }
          return null;
        }

        /* ── ヘルパー: 高速GET ── */
        async function doGet(fullUrl, timeout) {
          const u = new URL(fullUrl);
          return await httpsGet(u.hostname, u.pathname + u.search, authHeader, timeout || FAST_TIMEOUT);
        }

        /* ── ヘルパー: 時間チェック（12秒以内に返す） ── */
        function isOverDeadline() {
          return (Date.now() - handlerStart) > 12000;
        }

        // ── ステップ1: statusUrl（fal.aiが返した正しいURL）を最優先 ──
        const primaryUrl = statusUrl || `https://${FAL_Q}/${modelPath}/requests/${requestId}/status`;
        console.log(`[status] GET ${primaryUrl}`);

        let sData = null;
        try {
          const r = await doGet(primaryUrl);
          console.log(`[status] → HTTP ${r.status} body: ${r.body.slice(0, 200)}`);
          if (r.status === 200) {
            try { sData = JSON.parse(r.body); } catch(e) { /* パース失敗 */ }
          }
          if (r.status === 404) {
            return jsonRes(res, 200, { status: 'FAILED', error: 'リクエストID不明(404)' });
          }
        } catch(e) {
          console.warn(`[status] primary エラー:`, e.message);
        }

        // statusUrl が失敗 → 1つだけフォールバック（時間があれば）
        if (!sData && !isOverDeadline()) {
          const fallbackUrl = statusUrl
            ? `https://${FAL_Q}/${modelPath}/requests/${requestId}/status`
            : `https://${FAL_Q}/requests/${requestId}/status`;
          console.log(`[status] fallback: GET ${fallbackUrl}`);
          try {
            const r = await doGet(fallbackUrl);
            console.log(`[status] fallback → HTTP ${r.status} body: ${r.body.slice(0, 200)}`);
            if (r.status === 200) {
              try { sData = JSON.parse(r.body); } catch(e) { /* */ }
            }
          } catch(e) {
            console.warn(`[status] fallback エラー:`, e.message);
          }
        }

        // ステータス取得できなかった → すぐIN_PROGRESS返す（次のポーリングで再試行）
        if (!sData) {
          console.warn('[status] ステータス取得失敗 → IN_PROGRESS返却');
          return jsonRes(res, 200, { status: 'IN_PROGRESS', detail: '接続確認中...' });
        }

        const falStatus = sData.status || 'UNKNOWN';
        const qpos = sData.queue_position != null ? sData.queue_position : null;
        console.log(`[status] ${requestId.slice(0,12)}…: ${falStatus} (pos=${qpos})`);

        // ── IN_QUEUE / IN_PROGRESS → すぐ返す ──
        if (falStatus === 'IN_QUEUE' || falStatus === 'IN_PROGRESS') {
          const detail = qpos != null ? `キュー${qpos}番目` : falStatus;
          return jsonRes(res, 200, { status: 'IN_PROGRESS', detail });
        }

        // ── FAILED ──
        if (falStatus === 'FAILED') {
          const errMsg = sData.error?.message || sData.error || sData.detail || '生成失敗';
          console.error('[status] FAILED:', errMsg);
          return jsonRes(res, 200, { status: 'FAILED', error: errMsg });
        }

        // ── COMPLETED → 動画URLを取得 ──
        if (falStatus === 'COMPLETED') {
          console.log('[status] COMPLETED — keys:', Object.keys(sData).join(','));
          console.log('[status] COMPLETED — body:', JSON.stringify(sData).slice(0, 600));
          let videoUrl = deepFindVideoUrl(sData);

          // sData内に動画URLがない → response_url を試行
          if (!videoUrl && !isOverDeadline()) {
            const respUrl = responseUrl || sData.response_url;
            if (respUrl) {
              try {
                console.log(`[status] response_url: GET ${respUrl.slice(0,80)}`);
                const rr = await doGet(respUrl);
                console.log(`[status] response_url → HTTP ${rr.status} body: ${rr.body.slice(0,200)}`);
                if (rr.status === 200) {
                  let rd; try { rd = JSON.parse(rr.body); } catch(e) { rd = null; }
                  if (rd) videoUrl = deepFindVideoUrl(rd);
                }
              } catch(e) { console.warn('[status] response_url失敗:', e.message); }
            }
          }

          // まだ見つからない → /result を試行
          if (!videoUrl && !isOverDeadline()) {
            const resultUrl = `https://${FAL_Q}/${modelPath}/requests/${requestId}/result`;
            try {
              console.log(`[status] result: GET ${resultUrl}`);
              const rr = await doGet(resultUrl);
              console.log(`[status] result → HTTP ${rr.status} body: ${rr.body.slice(0,200)}`);
              if (rr.status === 200) {
                let rd; try { rd = JSON.parse(rr.body); } catch(e) { rd = null; }
                if (rd) videoUrl = deepFindVideoUrl(rd);
              }
            } catch(e) { console.warn('[status] result失敗:', e.message); }
          }

          if (videoUrl) {
            console.log(`[status] 動画URL取得成功: ${videoUrl.slice(0,80)}`);
            return jsonRes(res, 200, { status: 'COMPLETED', videoUrl });
          }

          console.error(`[status] COMPLETED だが動画URL未発見: ${JSON.stringify(sData).slice(0,400)}`);
          return jsonRes(res, 200, { status: 'FAILED', error: `動画URL取得失敗。API応答: ${JSON.stringify(sData).slice(0,200)}` });
        }

        // ── その他（UNKNOWN等） ──
        return jsonRes(res, 200, { status: 'IN_PROGRESS', detail: falStatus });

      } catch(err) {
        const ms = Date.now() - handlerStart;
        console.error(`[status] 例外(${ms}ms):`, err.message);
        const isTransient = err.message.includes('timeout') || err.message.includes('ECONNRESET')
                         || err.message.includes('ECONNREFUSED') || err.message.includes('socket');
        jsonRes(res, 200, {
          status: isTransient ? 'IN_PROGRESS' : 'FAILED',
          detail: isTransient ? 'network_retry' : undefined,
          error:  isTransient ? undefined : err.message,
        });
      }
    })();
    return;
  }

  /* ── /el/* → api.elevenlabs.io ── */
  if (pathname.startsWith('/el/')) {
    proxyRequest(req, res, EL_HOST, pathname.replace('/el','') + (parsedUrl.search||''));
    return;
  }

  /* ── /vv/* → VOICEVOX ── */
  if (pathname.startsWith('/vv/')) {
    proxyRequest(req, res, '127.0.0.1', pathname.replace('/vv','') + (parsedUrl.search||''), true);
    return;
  }

  /* ── Static files ── */
  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n✅ v3サーバー起動: http://localhost:${PORT}`);
  console.log(`   fal.ai: /api/generate  /api/status/:id`);
  console.log(`   ElevenLabs: /el/*   VOICEVOX: /vv/*\n`);
});
