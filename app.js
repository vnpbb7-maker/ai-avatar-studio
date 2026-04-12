/* ============================================================
   v3/app.js — SadTalker × ElevenLabs / VOICEVOX / 録音
   Flow:
     1. Upload image → fal.ai storage → get URL
     2. Generate audio (ElevenLabs / VOICEVOX / recording)
     3. Upload audio → fal.ai storage → get URL
     4. POST to fal-ai/sadtalker queue → request_id
     5. Poll queue status → get video URL
     6. Show & download result
============================================================ */
'use strict';

const FAL_BASE  = '/fal';
const FALQ_BASE = '/falq';
const FALST     = '/falst';
const EL_BASE   = '/el/v1';
const VV_BASE   = '/vv';

const SADTALKER_MODEL = 'fal-ai/sadtalker';
const POLL_MS   = 4000;
const MAX_POLLS = 180;  // 12 minutes

// ── State ────────────────────────────────────────────────────
const state = {
  falKey:        '',
  elKey:         '',
  imageFile:     null,
  audioBlob:     null,
  audioMode:     'el',       // 'el' | 'vv' | 'rec'
  selectedElVoice: null,
  selectedVVSpeaker: null,
  resolution:    '256',
  generating:    false,
  // rec
  mediaRecorder:  null,
  audioChunks:    [],
  recSeconds:     0,
  recTimerHandle: null,
  audioCtx:       null,
  analyser:       null,
  animFrameId:    null,
  elVoices:       [],
  vvSpeakers:     [],
  // prompt panel
  promptPreset:   'business',    // 'business' | 'sns' | 'news' | 'custom'
  promptLip:      'subtle',      // 'subtle' | 'natural' | 'expressive'
  promptBody:     'minimal',     // 'static' | 'minimal' | 'moderate' | 'dynamic'
  promptGesture:  false,
  promptCamera:   'static',      // 'static' | 'push-in' | 'orbital'
  promptPanelOpen: true,
  // flag: true = auto-sync with controls; false = user edited manually
  promptUserEdited: false,
  // mask
  maskFile:        null,
  maskDataUrl:     null,
};

// ── DOM refs ─────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const D = {
  falKeyInput: $('falKeyInput'),
  elKeyInput:  $('elKeyInput'),
  saveKeys:    $('saveKeys'),
  // tabs
  tabEl: $('tabEl'), tabVV: $('tabVV'), tabRec: $('tabRec'),
  panelEl: $('panelEl'), panelVV: $('panelVV'), panelRec: $('panelRec'),
  // EL
  elVoiceGrid: $('elVoiceGrid'), elBadge: $('elBadge'),
  scriptInput: $('scriptInput'), charCount: $('charCount'),
  // VV
  vvStatus: $('vvStatus'), vvDot: $('vvDot'), vvStatusText: $('vvStatusText'),
  vvVoiceGrid: $('vvVoiceGrid'), vvCheckBtn: $('vvCheckBtn'),
  scriptInputVV: $('scriptInputVV'), charCountVV: $('charCountVV'),
  // Rec
  waveCanvas: $('waveCanvas'),
  recDot: $('recDot'), recTimer: $('recTimer'), recStatus: $('recStatus'),
  recBtn: $('recBtn'), recPlayback: $('recPlayback'),
  recAudio: $('recAudio'), reRecBtn: $('reRecBtn'),
  // Image
  imgZone: $('imgZone'), imgInput: $('imgInput'),
  // Mask
  maskInput:   $('maskInput'),
  clearMask:   $('clearMask'),
  maskPreview: $('maskPreview'),
  // Quality
  // Quality
  qualityGrid: $('qualityGrid'),
  // Prompt panel
  promptPanelHeader: $('promptPanelHeader'),
  promptPanelBody:   $('promptPanelBody'),
  promptToggleIcon:  $('promptToggleIcon'),
  promptPreset:      $('promptPreset'),
  lipSeg:            $('lipSeg'),
  bodySeg:           $('bodySeg'),
  gestureToggle:     $('gestureToggle'),
  cameraSeg:         $('cameraSeg'),
  promptPreview:     $('promptPreview'),
  resetPromptBtn:    $('resetPromptBtn'),
  // Gen
  genBtn: $('genBtn'),
  progressCard: $('progressCard'),
  pBar: $('pBar'), pLabel: $('pLabel'),
  s1: $('s1'), s2: $('s2'), s3: $('s3'), s4: $('s4'), s5: $('s5'),
  // Preview
  prevEmpty: $('prevEmpty'), prevImg: $('prevImg'), prevVideo: $('prevVideo'),
  genOverlay: $('genOverlay'), overlayEta: $('overlayEta'),
  statusPill: $('statusPill'), resultActions: $('resultActions'),
  dlBtn: $('dlBtn'), makeAnotherBtn: $('makeAnotherBtn'),
  toastContainer: $('toastContainer'),
};

// ── MS Voices fallback ────────────────────────────────────────
const MS_VOICES = [
  { id:'ja-JP-NanamiNeural', name:'七海', sub:'女性・自然', emoji:'👩' },
  { id:'ja-JP-KeitaNeural',  name:'慶太', sub:'男性・自然', emoji:'👨' },
  { id:'ja-JP-AoiNeural',    name:'葵',   sub:'女性・明るい', emoji:'👧' },
  { id:'ja-JP-DaichiNeural', name:'大地', sub:'男性・若い', emoji:'🧑' },
];

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initParticles();
  loadKeys();
  bindEvents();
  initPromptPanel();
});

// APIキーをASCII printable文字のみに絞る（コピペ時の全角スペース・改行・制御文字を除去）
function sanitizeKey(raw) {
  return (raw || '').replace(/[^\x20-\x7E]/g, '').trim();
}

function loadKeys() {
  state.falKey = sanitizeKey(localStorage.getItem('fal_api_key') || '');
  state.elKey  = sanitizeKey(localStorage.getItem('el_api_key')  || '');
  if (D.falKeyInput) D.falKeyInput.value = state.falKey ? '••••••••••••' : '';
  if (D.elKeyInput)  D.elKeyInput.value  = state.elKey  ? '••••••••••••' : '';
  // 保存済きキーがある場合はボタンを「保存済✅」に変更
  if (D.saveKeys) {
    if (state.falKey) {
      D.saveKeys.textContent = '保存済 ✅';
      D.saveKeys.style.background = 'linear-gradient(135deg,#10b981,#059669)';
    } else {
      D.saveKeys.textContent = '保存';
      D.saveKeys.style.background = '';
    }
  }
  if (state.elKey) fetchElVoices();
  else             buildElGrid(null);
  // ページ読み込み時にボタン有効化条件を再評価
  setTimeout(checkCanGenerate, 100);
}

// ── Particles ─────────────────────────────────────────────────
function initParticles() {
  const c = $('px'); if (!c) return;
  const ctx = c.getContext('2d');
  const resize = () => { c.width = innerWidth; c.height = innerHeight; };
  resize(); addEventListener('resize', resize);
  const pts = Array.from({length:45}, () => ({
    x: Math.random()*innerWidth, y: Math.random()*innerHeight,
    r: Math.random()*1.5+.3, vx:(Math.random()-.5)*.3, vy:-(Math.random()*.45+.1),
    a: Math.random()*.5+.15, h: Math.random()>.5?250:200,
  }));
  (function draw() {
    ctx.clearRect(0,0,c.width,c.height);
    pts.forEach(p => {
      p.x+=p.vx; p.y+=p.vy;
      if (p.y<-5){p.y=c.height+5;p.x=Math.random()*c.width;}
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`hsla(${p.h},75%,65%,${p.a})`;ctx.fill();
    });
    requestAnimationFrame(draw);
  })();
}

// ── ElevenLabs voices ─────────────────────────────────────────
async function fetchElVoices() {
  D.elBadge.textContent = '⏳ 取得中...';
  try {
    const res = await fetch(`${EL_BASE}/voices`, {
      headers: { 'xi-api-key': state.elKey, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    const voices = (data.voices || [])
      .filter(v => v.category === 'premade' || v.category === 'cloned')
      .sort((a,b) => (a.category==='premade'?0:1)-(b.category==='premade'?0:1))
      .slice(0,9);
    state.elVoices = voices.length ? voices : null;
    buildElGrid(voices.length ? voices : null);
  } catch {
    buildElGrid(null);
  }
}

function buildElGrid(voices) {
  const list = voices && voices.length ? voices.map(v => ({
    id: v.voice_id,
    name: v.name,
    sub: ((v.labels?.gender==='male'?'男性':v.labels?.gender==='female'?'女性':'') +
          (v.labels?.accent?'・'+v.labels.accent:'')) || 'ElevenLabs',
    emoji: v.labels?.gender==='male'?'👨':'👩',
  })) : MS_VOICES;

  const isEl = !!(voices && voices.length);
  D.elBadge.textContent = isEl ? `✨ ElevenLabs (${list.length})` : 'Microsoft Neural';
  state.selectedElVoice = list[0].id;

  D.elVoiceGrid.innerHTML = list.map((v,i) => `
    <div class="voice-card${i===0?' sel':''}" data-voice="${v.id}">
      <div class="voice-avatar">${v.emoji}</div>
      <div class="voice-name">${v.name}</div>
      <div class="voice-sub">${v.sub}</div>
    </div>`).join('');
  D.elVoiceGrid.querySelectorAll('.voice-card').forEach(c => {
    c.addEventListener('click', () => {
      D.elVoiceGrid.querySelectorAll('.voice-card').forEach(x=>x.classList.remove('sel'));
      c.classList.add('sel');
      state.selectedElVoice = c.dataset.voice;
    });
  });
}

// ── VOICEVOX ─────────────────────────────────────────────────
async function checkVoicevox() {
  D.vvDot.className = 'vv-dot';
  D.vvStatusText.textContent = '接続確認中...';
  try {
    const res = await fetch(`${VV_BASE}/speakers`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error();
    const speakers = await res.json();
    state.vvSpeakers = speakers;
    D.vvDot.className = 'vv-dot ok';
    D.vvStatusText.textContent = `✅ VOICEVOX接続OK (${speakers.length}キャラクター)`;
    buildVVGrid(speakers);
    checkCanGenerate();
  } catch {
    D.vvDot.className = 'vv-dot ng';
    D.vvStatusText.textContent = '❌ 未接続 — VOICEVOXアプリを起動してください';
    D.vvVoiceGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--text-3);font-size:.78rem;padding:12px">VOICEVOXを起動してから「接続確認」を押してください</div>';
  }
}

function buildVVGrid(speakers) {
  // 全スタイルをフラット化
  const all = speakers.flatMap(s =>
    s.styles.map(st => ({ id: st.id, name: s.name, style: st.name }))
  );

  // 優先順位: 後鬼 → ナースロボ → その他
  const priority = (v) => {
    if (v.name === '後鬼')                                   return 0;
    if (v.name.includes('ナースロボ'))                       return 1;
    return 99;
  };
  const sorted = [...all].sort((a, b) => priority(a) - priority(b));
  const list = sorted.slice(0, 9);

  state.selectedVVSpeaker = list[0]?.id;
  D.vvVoiceGrid.innerHTML = list.map((v,i)=>`
    <div class="voice-card${i===0?' sel':''}" data-speaker="${v.id}">
      <div class="voice-avatar">🎵</div>
      <div class="voice-name" style="font-size:.73rem">${v.name}</div>
      <div class="voice-sub">${v.style}</div>
    </div>`).join('');
  D.vvVoiceGrid.querySelectorAll('.voice-card').forEach(c=>{
    c.addEventListener('click',()=>{
      D.vvVoiceGrid.querySelectorAll('.voice-card').forEach(x=>x.classList.remove('sel'));
      c.classList.add('sel');
      state.selectedVVSpeaker = parseInt(c.dataset.speaker);
    });
  });
}

// ── Bind events ───────────────────────────────────────────────
function bindEvents() {
  // Save keys
  D.saveKeys.addEventListener('click', () => {
    const fk = sanitizeKey(D.falKeyInput.value);
    const ek = sanitizeKey(D.elKeyInput.value);
    if (fk && !fk.startsWith('••')) {
      state.falKey = fk;
      localStorage.setItem('fal_api_key', fk);
    }
    if (ek && !ek.startsWith('••')) {
      state.elKey = ek;
      localStorage.setItem('el_api_key', ek);
      fetchElVoices();
    }
    if (!state.falKey) { toast('fal.ai APIキーを入力してください', 'error'); return; }
    // 保存後、入力欄をマスク表示に更新
    if (state.falKey) D.falKeyInput.value = '••••••••••••';
    if (state.elKey)  D.elKeyInput.value  = '••••••••••••';
    // ボタンを「保存済✅」に変更
    D.saveKeys.textContent = '保存済 ✅';
    D.saveKeys.style.background = 'linear-gradient(135deg,#10b981,#059669)';
    toast('✅ APIキーを保存しました（次回から自動ロード）', 'success');
    checkCanGenerate();
  });
  // 入力欄にフォーカスが来たらボタンを「保存」に戻す
  [D.falKeyInput, D.elKeyInput].forEach(inp => {
    inp.addEventListener('focus', () => {
      D.saveKeys.textContent = '保存';
      D.saveKeys.style.background = '';
      if (inp.value === '••••••••••••') inp.value = '';
    });
  });

  // Tabs
  D.tabEl.addEventListener('click',  () => setMode('el'));
  D.tabVV.addEventListener('click',  () => { setMode('vv'); if(!state.vvSpeakers.length) checkVoicevox(); });
  D.tabRec.addEventListener('click', () => setMode('rec'));
  D.vvCheckBtn.addEventListener('click', checkVoicevox);

  // Image upload
  D.imgZone.addEventListener('click', e => { if(!e.target.closest('label')) D.imgInput.click(); });
  D.imgZone.addEventListener('dragenter', e=>{e.preventDefault();D.imgZone.classList.add('drag');});
  D.imgZone.addEventListener('dragover',  e=>{e.preventDefault();D.imgZone.classList.add('drag');});
  D.imgZone.addEventListener('dragleave', e=>{if(!D.imgZone.contains(e.relatedTarget))D.imgZone.classList.remove('drag');});
  D.imgZone.addEventListener('drop', e=>{e.preventDefault();D.imgZone.classList.remove('drag');if(e.dataTransfer.files[0])handleImage(e.dataTransfer.files[0]);});
  D.imgInput.addEventListener('change', e=>{ if(e.target.files[0]) handleImage(e.target.files[0]); });
  document.addEventListener('dragover',e=>e.preventDefault());
  document.addEventListener('drop',e=>e.preventDefault());

  // Script char count
  D.scriptInput.addEventListener('input', () => {
    const n = D.scriptInput.value.length;
    D.charCount.textContent = `${n} / 500`;
    D.charCount.className = 'char-count'+(n>450?(n>=500?' over':' warn'):'');
    checkCanGenerate();
  });
  D.scriptInputVV.addEventListener('input', () => {
    const n = D.scriptInputVV.value.length;
    D.charCountVV.textContent = `${n} / 500`;
    D.charCountVV.className = 'char-count'+(n>450?(n>=500?' over':' warn'):'');
    checkCanGenerate();
  });

  // Quality
  D.qualityGrid.querySelectorAll('.quality-card').forEach(c=>{
    c.addEventListener('click',()=>{
      D.qualityGrid.querySelectorAll('.quality-card').forEach(x=>x.classList.remove('sel'));
      c.classList.add('sel');
      state.resolution = c.dataset.res;
    });
  });

  // Expression slider は OmniHuman では不使用

  // Rec
  D.recBtn.addEventListener('click', toggleRec);
  D.reRecBtn.addEventListener('click', resetRec);

  // Generate / reset
  D.genBtn.addEventListener('click', startGeneration);
  D.makeAnotherBtn.addEventListener('click', resetAll);

  // ── Mask upload events ────────────────────────
  D.maskInput.addEventListener('change', e => {
    if (e.target.files[0]) handleMask(e.target.files[0]);
  });
  D.clearMask.addEventListener('click', () => {
    state.maskFile    = null;
    state.maskDataUrl = null;
    D.maskInput.value = '';
    D.maskPreview.innerHTML = '';
    D.clearMask.style.display = 'none';
    toast('🎭 マスクをクリアしました', 'info');
  });

  // ── Prompt Panel events ─────────────────────────

  // Fold/unfold
  D.promptPanelHeader.addEventListener('click', () => {
    state.promptPanelOpen = !state.promptPanelOpen;
    const body  = D.promptPanelBody;
    const icon  = D.promptToggleIcon;
    if (state.promptPanelOpen) {
      body.style.display = '';
      icon.classList.remove('collapsed');
    } else {
      body.style.display = 'none';
      icon.classList.add('collapsed');
    }
  });

  // Preset select
  D.promptPreset.addEventListener('change', () => {
    state.promptPreset = D.promptPreset.value;
    state.promptUserEdited = false;
    const isCustom = state.promptPreset === 'custom';
    // In custom mode, unlock the textarea and keep whatever is in it
    if (isCustom) {
      D.promptPreview.readOnly = false;
    } else {
      D.promptPreview.readOnly = false;
      updatePromptPreview();
    }
  });

  // Segment buttons helper
  function bindSeg(container, stateKey) {
    container.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state[stateKey] = btn.dataset.val;
        if (state.promptPreset !== 'custom') {
          state.promptUserEdited = false;
          updatePromptPreview();
        }
      });
    });
  }
  bindSeg(D.lipSeg,    'promptLip');
  bindSeg(D.bodySeg,   'promptBody');
  bindSeg(D.cameraSeg, 'promptCamera');

  // Gesture toggle
  D.gestureToggle.addEventListener('change', () => {
    state.promptGesture = D.gestureToggle.checked;
    if (state.promptPreset !== 'custom') {
      state.promptUserEdited = false;
      updatePromptPreview();
    }
  });

  // User edits textarea directly
  D.promptPreview.addEventListener('input', () => {
    state.promptUserEdited = true;
  });

  // Reset button
  D.resetPromptBtn.addEventListener('click', () => {
    state.promptUserEdited = false;
    if (state.promptPreset === 'custom') {
      D.promptPreview.value = '';
    } else {
      updatePromptPreview();
    }
  });
}

function setMode(mode) {
  state.audioMode = mode;
  [D.tabEl,D.tabVV,D.tabRec].forEach(t=>t.classList.remove('active'));
  [D.panelEl,D.panelVV,D.panelRec].forEach(p=>p.style.display='none');
  if (mode==='el')  { D.tabEl.classList.add('active');  D.panelEl.style.display=''; }
  if (mode==='vv')  { D.tabVV.classList.add('active');  D.panelVV.style.display=''; }
  if (mode==='rec') { D.tabRec.classList.add('active'); D.panelRec.style.display=''; }
  checkCanGenerate();
}

// ── Prompt Panel ──────────────────────────────────────────

/**
 * Safety prefix — 常に最前に付加される安全プロンプト。
 * ペット・複数人の口パク防止＋identity drift振れ辺み防止。
 */
const SAFETY_PROMPT_PREFIX =
  'Only the human person in the foreground is speaking. ' +
  'All animals, pets, and non-human subjects in the frame ' +
  'remain completely still and silent with closed mouths. ' +
  "Preserve the speaker's facial identity, skin tone, and " +
  'facial structure exactly as shown in the input image throughout ' +
  'the entire video. No identity drift. ';

// Preset base texts
const PRESETS = {
  business: 'A static medium shot holds steadily. The character speaks calmly and professionally with subtle, restrained lip movements and minimal mouth opening. Body remains composed and upright with only slight natural breathing movement. No exaggerated gestures. Facial expression is focused and warm, with small natural micro-expressions responding to speech rhythm.',
  sns:      'Camera slowly pushes in from medium shot to medium close-up. The character speaks directly to camera with natural, understated lip movements. Occasional gentle head tilt, relaxed shoulder movement. Hands rise naturally at emphasis points then return to rest. Expression is warm and engaging without exaggeration.',
  news:     'A stable, static medium shot. The character delivers speech with precise, controlled lip movements—natural and measured, never exaggerated. Upright posture, minimal body movement. Eyes engage directly with camera. Expression shifts subtly with content tone, transitioning from neutral to slight warmth as speech progresses.',
  custom:   '',
};

// Lip movement clauses
const LIP_CLAUSES = {
  subtle:     'subtle lip movements, minimal mouth opening, jaw relaxed and still',
  natural:    '',  // natural is the default in preset — no extra clause
  expressive: 'expressive lip movements, wide mouth articulation',
};

// Body movement clauses
const BODY_CLAUSES = {
  static:   'static body posture, no upper body movement',
  minimal:  'slight natural breathing motion only, no shoulder sway',
  moderate: 'gentle organic upper body sway, occasional slight head tilt',
  dynamic:  'animated upper body movement, expressive shoulder and torso engagement',
};

// Gesture clauses
const GESTURE_ON  = 'measured hand gestures within chest-to-shoulder frame, hands rise naturally at key points';
const GESTURE_OFF = 'hands remain still and out of frame';

// Camera clauses
const CAMERA_CLAUSES = {
  'static':  'Camera: static medium shot',
  'push-in': 'Camera slowly pushes in from medium shot to medium close-up',
  'orbital': 'Camera performs a slow orbital movement from front to three-quarter view',
};

const MAX_PROMPT_LENGTH = 500; // fal.ai OmniHuman v1.5 の安全上限

/**
 * Build the final prompt string from current state.
 * For 'custom' preset, returns undefined so the API field is omitted.
 * Always prepends SAFETY_PROMPT_PREFIX to keep animals/identity stable.
 * Truncates to MAX_PROMPT_LENGTH to prevent API rejection.
 */
function buildPrompt() {
  if (state.promptPreset === 'custom') return undefined;

  const base = PRESETS[state.promptPreset] || '';
  const parts = [base];

  const lip = LIP_CLAUSES[state.promptLip];
  if (lip) parts.push(lip);

  const body = BODY_CLAUSES[state.promptBody];
  if (body) parts.push(body);

  parts.push(state.promptGesture ? GESTURE_ON : GESTURE_OFF);

  const cam = CAMERA_CLAUSES[state.promptCamera];
  if (cam) parts.push(cam);

  const userPart = parts.filter(Boolean).join('. ');
  const combined = SAFETY_PROMPT_PREFIX + userPart;
  return combined.length > MAX_PROMPT_LENGTH
    ? combined.substring(0, MAX_PROMPT_LENGTH)
    : combined;
}

/** Sync the textarea with the current control state (unless user edited manually). */
function updatePromptPreview() {
  if (state.promptUserEdited) return;
  if (state.promptPreset === 'custom') return;  // leave as-is for custom
  D.promptPreview.value = buildPrompt();
}

/** Get the effective prompt to send to the API (max MAX_PROMPT_LENGTH chars). */
function getEffectivePrompt() {
  let result;
  if (state.promptPreset === 'custom') {
    const t = D.promptPreview.value.trim();
    if (t.length === 0) {
      result = SAFETY_PROMPT_PREFIX.trim();
    } else if (!t.startsWith('Only the human person')) {
      result = SAFETY_PROMPT_PREFIX + t;
    } else {
      result = t;
    }
  } else if (state.promptUserEdited) {
    const t = D.promptPreview.value.trim();
    result = t.length > 0 ? t : SAFETY_PROMPT_PREFIX.trim();
  } else {
    const p = buildPrompt();
    result = (p && p.trim().length > 0) ? p : SAFETY_PROMPT_PREFIX.trim();
  }
  // 必ず500文字以内に収める（fal.ai API拒否防止）
  if (result && result.length > MAX_PROMPT_LENGTH) {
    result = result.substring(0, MAX_PROMPT_LENGTH);
  }
  return result;
}

/** Initialize prompt panel on page load. */
function initPromptPanel() {
  // Render initial preview
  updatePromptPreview();
}

function checkCanGenerate() {
  const hasKey   = !!state.falKey;
  const hasImage = !!state.imageFile;
  const hasAudio = state.audioMode==='el'  ? D.scriptInput.value.trim().length>1
                 : state.audioMode==='vv'  ? (D.scriptInputVV.value.trim().length>1 && state.selectedVVSpeaker!=null)
                 : !!state.audioBlob;
  D.genBtn.disabled = !(hasKey && hasImage && hasAudio);
}

// ── Image ─────────────────────────────────────────────────────
function handleImage(file) {
  if (!file.type.startsWith('image/')) { toast('画像ファイルを選択してください', 'error'); return; }
  if (file.size > 20*1024*1024) { toast('20MB以下の画像を選択してください', 'error'); return; }
  state.imageFile = file;
  const url = URL.createObjectURL(file);
  D.imgZone.classList.add('has-file');
  D.imgZone.innerHTML = `<img src="${url}" class="upload-preview" alt="preview">`;
  D.prevEmpty.style.display = 'none';
  D.prevImg.src = url; D.prevImg.classList.remove('hidden');
  D.prevVideo.classList.add('hidden');
  setStatus('準備完了','');
  toast('✅ 画像を読み込みました','success');
  checkCanGenerate();
}

// ── Mask ─────────────────────────────────────────────────────
async function handleMask(file) {
  if (!file.type.startsWith('image/')) { toast('画像ファイルを選択してください', 'error'); return; }
  if (file.size > 10*1024*1024) { toast('10MB以下の画像を選択してください', 'error'); return; }
  state.maskFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    state.maskDataUrl = e.target.result;
    D.maskPreview.innerHTML = `
      <div class="mask-preview-inner">
        <img src="${state.maskDataUrl}" alt="mask preview" style="max-width:100%;max-height:80px;border-radius:6px;border:1px solid rgba(16,185,129,.4);">
        <span class="mask-ok-badge">✅ マスク設定済</span>
      </div>`;
    D.clearMask.style.display = '';
    toast('✅ マスク画像を読み込みました', 'success');
  };
  reader.onerror = () => toast('マスク画像の読み込みに失敗しました', 'error');
  reader.readAsDataURL(file);
}

// ── Recording ─────────────────────────────────────────────────
async function toggleRec() {
  if (!state.mediaRecorder || state.mediaRecorder.state==='inactive') await startRec();
  else stopRec();
}
async function startRec() {
  if (state.audioCtx?.state !== 'closed') try{await state.audioCtx?.close();}catch{}
  cancelAnimationFrame(state.animFrameId);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio:true});
    state.audioChunks=[]; state.recSeconds=0; state.audioBlob=null;
    D.recPlayback.style.display='none'; D.recAudio.src='';
    state.audioCtx = new AudioContext();
    if(state.audioCtx.state==='suspended') await state.audioCtx.resume();
    state.analyser = state.audioCtx.createAnalyser();
    state.analyser.fftSize = 256;
    state.audioCtx.createMediaStreamSource(stream).connect(state.analyser);
    const c=D.waveCanvas; c.width=c.offsetWidth||400; c.height=50;
    drawWave();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'audio/webm';
    state.mediaRecorder = new MediaRecorder(stream,{mimeType:mime});
    state.mediaRecorder.ondataavailable=e=>{if(e.data.size>0)state.audioChunks.push(e.data);};
    state.mediaRecorder.onstop=()=>{
      stream.getTracks().forEach(t=>t.stop());
      state.audioCtx?.close();
      cancelAnimationFrame(state.animFrameId); clearWave();
      const blob=new Blob(state.audioChunks,{type:mime});
      state.audioBlob=blob;
      D.recAudio.src=URL.createObjectURL(blob);
      D.recPlayback.style.display='';
      checkCanGenerate();
      toast('✅ 録音完了！','success');
    };
    state.mediaRecorder.start(100);
    state.recTimerHandle=setInterval(()=>{
      state.recSeconds++;
      D.recTimer.textContent=`${String(Math.floor(state.recSeconds/60)).padStart(2,'0')}:${String(state.recSeconds%60).padStart(2,'0')}`;
    },1000);
    D.recBtn.classList.add('recording');
    D.recBtn.querySelector('.rec-icon').textContent='⏹';
    D.recBtn.querySelector('.rec-lbl').textContent='停止';
    D.recDot.classList.add('on'); D.recStatus.textContent='録音中...';
  } catch(err){ toast('マイクエラー: '+err.message,'error'); }
}
function stopRec(){
  if(state.mediaRecorder?.state!=='inactive') state.mediaRecorder?.stop();
  clearInterval(state.recTimerHandle);
  D.recBtn.classList.remove('recording');
  D.recBtn.querySelector('.rec-icon').textContent='🎙️';
  D.recBtn.querySelector('.rec-lbl').textContent='録音開始';
  D.recDot.classList.remove('on'); D.recStatus.textContent='録音完了';
}
function resetRec(){
  stopRec(); state.audioBlob=null;
  D.recPlayback.style.display='none'; D.recAudio.src='';
  D.recTimer.textContent='00:00'; D.recStatus.textContent='録音待機中';
  clearWave(); checkCanGenerate();
}
function drawWave(){
  const c=D.waveCanvas; const ctx=c.getContext('2d');
  const buf=new Uint8Array(state.analyser.frequencyBinCount);
  (function loop(){
    state.animFrameId=requestAnimationFrame(loop);
    state.analyser.getByteTimeDomainData(buf);
    ctx.clearRect(0,0,c.width,c.height);
    ctx.lineWidth=2.5; ctx.strokeStyle='#7c3aed'; ctx.beginPath();
    const sw=c.width/buf.length; let x=0;
    buf.forEach((v,i)=>{const y=(v/128)*(c.height/2); i===0?ctx.moveTo(x,y):ctx.lineTo(x,y); x+=sw;});
    ctx.lineTo(c.width,c.height/2); ctx.stroke();
  })();
}
function clearWave(){ D.waveCanvas.getContext('2d').clearRect(0,0,D.waveCanvas.width,D.waveCanvas.height); }

// ── 画像自動圧縮 → base64 data URI ────────────────────────────────
const IMG_MAX_PX   = 1024;
const IMG_MAX_BYTE = 2 * 1024 * 1024;

async function compressImageToDataURI(file) {
  const bmp = await createImageBitmap(file);
  const { width: ow, height: oh } = bmp;
  const scale = Math.min(1, IMG_MAX_PX / Math.max(ow, oh));
  const tw = Math.round(ow * scale), th = Math.round(oh * scale);
  const canvas = document.createElement('canvas');
  canvas.width = tw; canvas.height = th;
  canvas.getContext('2d').drawImage(bmp, 0, 0, tw, th);
  bmp.close();
  for (const q of [0.85, 0.75, 0.65, 0.50, 0.40]) {
    const uri = canvas.toDataURL('image/jpeg', q);
    const len = Math.round((uri.length - uri.indexOf(',') - 1) * 3 / 4);
    if (len <= IMG_MAX_BYTE) { console.log(`[compress] ${ow}x${oh}→${tw}x${th} q=${q} ${(len/1024).toFixed(0)}KB`); return uri; }
  }
  return canvas.toDataURL('image/jpeg', 0.35);
}

function fileToDataURI(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('ファイル読み込み失敗'));
    reader.readAsDataURL(file);
  });
}

// ── 音声WAV変換: 任意のBlobをPCM WAVに変換（fal.ai互換） ─────
/**
 * Float32Array (モノラル) → WAV Blob
 */
function float32ToWav(float32Data, sampleRate) {
  const numSamples = float32Data.length;
  const bytesPerSample = 2; // 16-bit PCM
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const bufSize = 44 + dataSize;
  const buf = new ArrayBuffer(bufSize);
  const view = new DataView(buf);

  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);         // chunk size
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);         // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Data[i]));
    view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
    offset += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * 任意のBlob → WAV Blob（16kHz モノラルに正規化）
 * fal.ai OmniHuman はWAVが最も安定して動作する
 */
async function ensureWavAudio(blob) {
  // 既にWAVならそのまま返す
  if (blob.type === 'audio/wav' || blob.type === 'audio/x-wav') {
    console.log(`[audio] WAVそのまま使用: ${(blob.size/1024).toFixed(0)}KB`);
    return blob;
  }
  console.log(`[audio] ${blob.type} (${(blob.size/1024).toFixed(0)}KB) → WAV変換中...`);
  try {
    const arrayBuf = await blob.arrayBuffer();
    const decodeCtx = new AudioContext();
    const decoded = await decodeCtx.decodeAudioData(arrayBuf);
    await decodeCtx.close();

    const SR = 16000;
    const offCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);
    const src = offCtx.createBufferSource();
    src.buffer = decoded;
    src.connect(offCtx.destination);
    src.start(0);
    const rendered = await offCtx.startRendering();

    const wavBlob = float32ToWav(rendered.getChannelData(0), SR);
    console.log(`[audio] WAV変換完了: ${(blob.size/1024).toFixed(0)}KB → ${(wavBlob.size/1024).toFixed(0)}KB (16kHz mono)`);
    return wavBlob;
  } catch(e) {
    console.warn('[audio] WAV変換失敗、元データ使用:', e.message);
    return blob;
  }
}

// ── MAIN GENERATION ───────────────────────────────────────────
async function startGeneration() {
  if (state.generating) return;
  if (!state.falKey) { toast('fal.ai APIキーを設定してください','error'); return; }

  state.generating = true;
  D.genBtn.disabled = true;
  D.progressCard.style.display='';
  D.resultActions.style.display='none';
  setStatus('生成中','gen');
  setProgress(0);
  [D.s1,D.s2,D.s3,D.s4,D.s5].forEach(s=>setStep(s,''));
  D.genOverlay.classList.remove('hidden');
  D.prevVideo.classList.add('hidden');

  try {
    // Step 1: 画像を圧縮してbase64化
    setStep(D.s1,'active'); setProgress(8);
    toast('🖼️ 画像を圧縮中...', 'info');
    const imageDataUrl = await compressImageToDataURI(state.imageFile);
    setStep(D.s1,'done'); setProgress(20);

    // Step 2: 音声を生成
    setStep(D.s2,'active'); setProgress(25);
    let audioBlob;
    if (state.audioMode==='el') {
      audioBlob = await generateElAudio(D.scriptInput.value.trim(), state.selectedElVoice);
    } else if (state.audioMode==='vv') {
      audioBlob = await generateVVAudio(D.scriptInputVV.value.trim(), state.selectedVVSpeaker);
    } else {
      audioBlob = state.audioBlob;
    }
    setStep(D.s2,'done'); setProgress(38);

    // Step 3: 音声をWAVに変換してbase64化
    setStep(D.s3,'active'); setProgress(42);
    toast('🔊 音声をWAVに変換中...', 'info');
    const wavAudio = await ensureWavAudio(audioBlob);
    const audioDataUrl = await fileToDataURI(new File([wavAudio], 'audio.wav', {type: 'audio/wav'}));
    setStep(D.s3,'done'); setProgress(50);

    // Step 4: アップロード & SadTalker生成（直接同期API、最大10分）
    setStep(D.s4,'active'); setProgress(55);
    D.overlayEta.textContent = 'アップロード中... OmniHuman全身生成開始（最大2分）';
    const result = await submitSadTalker(imageDataUrl, audioDataUrl);

    if (result.videoUrl) {
      // 直接同期API: 動画URLをそのまま取得
      setStep(D.s4,'done'); setStep(D.s5,'done'); setProgress(100);
      showResult(result.videoUrl);
    } else {
      // Queue API: ポーリングで待機
      setProgress(65);
        D.overlayEta.textContent = '全身動画キューイング中... 1〜3分かかります';
      setStep(D.s5,'active');
      const videoUrl = await pollSadTalker(result.requestId, result.modelPath, result.statusUrl, result.responseUrl);
      setStep(D.s4,'done'); setStep(D.s5,'done'); setProgress(100);
      showResult(videoUrl);
    }
  } catch(err) {
    handleError(err.message);
  }
}

// ── ElevenLabs TTS ────────────────────────────────────────────
async function generateElAudio(text, voiceId) {
  if (!state.elKey) {
    // Microsoft TTS fallback via D-ID-style (not available here, use EL-like)
    throw new Error('ElevenLabsキーが必要です。APIキー設定に入力してください。');
  }
  const res = await fetch(`${EL_BASE}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': state.elKey },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.30, similarity_boost: 0.85, style: 0.0, use_speaker_boost: true },
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(()=>({}));
    const msg = err.detail?.message || err.detail || '';
    throw new Error(`ElevenLabs TTS失敗 (${res.status}): ${msg || 'エラー'}`);
  }
  return await res.blob();
}

// ── VOICEVOX TTS ──────────────────────────────────────────────
async function generateVVAudio(text, speaker) {
  // Step1: audio_query
  const q = await fetch(`${VV_BASE}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, {method:'POST'});
  if (!q.ok) throw new Error(`VOICEVOX audio_query失敗 (${q.status})`);
  const query = await q.json();

  // Step2: synthesis
  const s = await fetch(`${VV_BASE}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(query),
  });
  if (!s.ok) throw new Error(`VOICEVOX synthesis失敗 (${s.status})`);
  return await s.blob(); // WAV blob
}

// ── SadTalker submit (/api/generate 経由) ─────────────────────
// server.js の /api/generate が画像・音声アップロード＋SadTalkerキュー送信を一括処理
async function submitSadTalker(imageDataUrl, audioDataUrl) {
  const falKey = sanitizeKey(state.falKey);
  const prompt = getEffectivePrompt();
  console.log('[SadTalker] POST /api/generate (画像+音声アップロード→OmniHuman送信)');
  console.log('[SadTalker] prompt length:', prompt ? prompt.length : 0, '/ max', MAX_PROMPT_LENGTH);
  console.log('[SadTalker] prompt preview:', prompt ? prompt.slice(0, 100) + (prompt.length > 100 ? '...' : '') : '(none)');
  console.log('[SadTalker] mask:', state.maskDataUrl ? '設定あり (~' + Math.round(state.maskDataUrl.length*3/4/1024) + 'KB)' : 'なし');

  // リクエストbody組み立て：必ずnull/undefinedが混入しないよう存在チェックしてから追加
  const body = {
    falKey,
    imageDataUrl,
    audioDataUrl,
    options: {
      resolution: state.resolution,
    },
  };
  // prompt: 空でない文字列の時のみ付加
  if (typeof prompt === 'string' && prompt.length > 0) body.options.prompt = prompt;
  // mask: 実在する有効なdata URIの時のみ付加（undefined/null/空で1切混入しない）
  if (typeof state.maskDataUrl === 'string' && state.maskDataUrl.startsWith('data:')) {
    body.maskDataUrl = state.maskDataUrl;
  }
  console.log('[SadTalker] request snapshot:', JSON.stringify({
    resolution: body.options.resolution,
    promptLength: (body.options.prompt || '').length,
    hasMask: !!body.maskDataUrl,
  }));
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(()=>'');
    console.error('[SadTalker] 送信失敗', res.status, t.slice(0,500));
    throw new Error(`SadTalker送信失敗 (${res.status}): ${t.slice(0,200)}`);
  }
  const data = await res.json();
  console.log('[SadTalker] レスポンス:', JSON.stringify(data));
  if (data.error) throw new Error(data.error);
  if (data.videoUrl)   return { videoUrl: data.videoUrl };    // 直接同期API
  if (data.request_id) return {
    requestId:   data.request_id,
    modelPath:   data.modelPath   || 'fal-ai/bytedance/omnihuman/v1.5',
    statusUrl:   data.status_url  || null,
    responseUrl: data.response_url || null,
  };
  throw new Error(`レスポンス形式不明: ${JSON.stringify(data)}`);
}

// ── OmniHuman poll (/api/status 経由) ───────────────────────────
async function pollSadTalker(requestId, modelPath, statusUrl, responseUrl) {
  const falKey = sanitizeKey(state.falKey);
  const model  = modelPath || 'fal-ai/bytedance/omnihuman/v1.5';
  let errCount = 0;
  const startTime = Date.now();
  console.log(`[poll] 開始 requestId=${requestId} model=${model}`);
  console.log(`[poll] statusUrl=${statusUrl || 'なし'}`);
  console.log(`[poll] responseUrl=${responseUrl || 'なし'}`);

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    // 進捗: 65%→94% — 最初の30秒で70%まで素早く上げ、その後ゆっくり
    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    const fastPhase = Math.min(5, Math.floor(elapsedSec / 6)); // 0-5 in first 30s
    const slowPhase = Math.max(0, Math.floor((elapsedSec - 30) / 20)); // 1 per 20s after 30s
    const pct = Math.min(94, 65 + fastPhase + slowPhase);
    setProgress(pct);

    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    const elStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;

    let data;
    try {
      // クエリパラメータで渡す（カスタムヘッダーはCORSプリフライトが必要になるため回避）
      const params = new URLSearchParams();
      params.set('key', falKey);
      params.set('model', model);
      if (statusUrl)   params.set('status_url', statusUrl);
      if (responseUrl) params.set('response_url', responseUrl);

      console.log(`[poll ${i}] ${elStr}経過 → GET /api/status/${requestId.slice(0,12)}...`);
      const res = await fetch(`/api/status/${requestId}?${params.toString()}`);
      data = await res.json();
      errCount = 0;
    } catch(e) {
      errCount++;
      console.warn(`[poll ${i}] fetch失敗 (${errCount}回目): ${e.message}`);
      D.overlayEta.textContent = `通信中... ${elStr}経過 (retry ${errCount})`;
      if (errCount >= 8) throw new Error('ステータス取得に繰り返し失敗しました');
      continue;
    }

    const detail = data.detail ? ` — ${data.detail}` : '';
    D.overlayEta.textContent = `全身動画生成中... ${elStr}経過${detail}`;
    console.log(`[poll ${i}] status=${data.status} detail=${data.detail||''} videoUrl=${data.videoUrl ? data.videoUrl.slice(0,60) : 'none'}`);

    if (data.status === 'COMPLETED') {
      if (!data.videoUrl) {
        console.error('[poll] COMPLETEDだがvideoUrlなし:', JSON.stringify(data));
        throw new Error('生成完了しましたが動画URLが取得できませんでした');
      }
      return data.videoUrl;
    }
    if (data.status === 'FAILED') throw new Error(data.error || 'OmniHuman生成に失敗しました');
    if (data.status === 'ERROR')  throw new Error(data.error || '内部エラー発生');
  }
  throw new Error('タイムアウト：生成に時間がかかりすぎています（最大12分）');
}

// ── Result ────────────────────────────────────────────────────
function showResult(videoUrl) {
  state.generating = false;
  D.genOverlay.classList.add('hidden');
  D.prevVideo.src = videoUrl;
  D.prevVideo.classList.remove('hidden');
  D.prevImg.classList.add('hidden');
  D.prevVideo.play();
  D.dlBtn.href = videoUrl;
  D.resultActions.style.display='';
  setStatus('完成！','done');
  toast('🎉 動画が完成しました！','success');
}

function handleError(msg) {
  state.generating = false;
  D.genBtn.disabled = false;
  D.genOverlay.classList.add('hidden');
  setStatus('エラー','err');
  [D.s1,D.s2,D.s3,D.s4,D.s5].forEach(s=>s.classList.remove('active','done'));
  toast('エラー: '+msg,'error');
  checkCanGenerate();
}

function resetAll() {
  state.imageFile = null; state.audioBlob = null; state.generating = false;
  D.imgZone.classList.remove('has-file');
  D.imgZone.innerHTML = `
    <div class="upload-inner">
      <span class="upload-icon">🖼️</span>
      <p class="upload-title">写真をドラッグ＆ドロップ</p>
      <p style="font-size:.78rem;color:var(--text-3);margin:4px 0 10px">または</p>
      <label class="btn btn-ghost" style="padding:7px 14px;font-size:.82rem" for="imgInput">ファイルを選択</label>
      <input type="file" id="imgInput" accept="image/jpeg,image/png,image/webp" hidden>
      <p class="upload-hint">JPG / PNG / WEBP • 正面向きの顔写真が最適</p>
    </div>`;
  D.imgZone.addEventListener('change', e=>{if(e.target.id==='imgInput'&&e.target.files[0])handleImage(e.target.files[0]);});
  D.prevImg.classList.add('hidden'); D.prevVideo.classList.add('hidden');
  D.prevEmpty.style.display=''; D.resultActions.style.display='none';
  D.progressCard.style.display='none'; setProgress(0);
  setStatus('待機中','');
  resetRec(); checkCanGenerate();
}

// ── UI helpers ────────────────────────────────────────────────
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function setProgress(p){ D.pBar.style.width=p+'%'; D.pLabel.textContent=p+'%'; }
function setStep(el,s){ el.classList.remove('active','done','error'); if(s) el.classList.add(s); }
function setStatus(t,c){ D.statusPill.textContent=t; D.statusPill.className='status-pill'+(c?' '+c:''); }
function toast(msg, type='info'){
  const el=document.createElement('div');
  el.className=`toast toast-${type}`;
  el.innerHTML=`<span>${{success:'✅',error:'❌',info:'💡'}[type]||''}</span><span>${msg}</span>`;
  D.toastContainer.appendChild(el);
  setTimeout(()=>{el.style.cssText='opacity:0;transform:translateX(20px);transition:all .3s';setTimeout(()=>el.remove(),310);},5000);
}
