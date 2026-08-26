// ============================================================
// Pollinations Studio · BYOK 纯前端应用
// 端点说明（依据官方 APIDOCS）：
//   新版统一 API: https://gen.pollinations.ai
//     图片 GET  /image/{prompt}
//     文本 POST /v1/chat/completions
//     模型 GET  /image/models, /v1/models
//   旧版（无 Key 也可用，作为回退）:
//     图片 GET  https://image.pollinations.ai/prompt/{prompt}
//     文本 POST https://text.pollinations.ai/openai
// 鉴权：Authorization: Bearer <key>，图片直连 URL 用 ?key=<key>
// ============================================================

const API = {
  get base() { return 'https://gen.pollinations.ai'; },
  get legacyImage() { return 'https://image.pollinations.ai'; },
  get legacyText() { return 'https://text.pollinations.ai'; }
};

const STORE = {
  key: 'pl_api_key',
  theme: 'pl_theme',
  hist: 'pl_history',
  anon: 'pl_anon',
  mascot: 'pl_mascot_pos'
};

const FALLBACK_IMAGE_MODELS = ['flux', 'turbo', 'kontext', 'gptimage', 'seedream'];
const FREE_IMAGE_MODELS = ['flux', 'turbo'];
const PREMIUM_IMAGE_MODELS = ['kontext', 'gptimage', 'seedream', 'klein', 'gptimage-large', 'gpt-image-2', 'nova-canvas', 'dreamshaper', 'zimage'];
const FALLBACK_TEXT_MODELS = ['openai', 'openai-fast', 'openai-large', 'openai-reasoning', 'mistral', 'searchgpt'];
const FREE_TEXT_MODELS = ['openai', 'openai-fast'];
const PREMIUM_TEXT_MODELS = ['openai-large', 'openai-reasoning', 'mistral', 'searchgpt'];
const FALLBACK_AUDIO_MODELS = ['grok-tts', 'qwen-tts', 'elevenlabs', 'elevenflash', 'kokoro', 'fish-audio-s2.1-pro'];
const FREE_AUDIO_MODELS = ['grok-tts', 'qwen-tts'];
const PREMIUM_AUDIO_MODELS = ['elevenlabs', 'elevenflash', 'kokoro', 'fish-audio-s2.1-pro'];
const FALLBACK_VIDEO_MODELS = ['minimax-h3', 'seedance-2.0', 'veo', 'wan', 'wan-fast', 'wan-pro', 'nova-reel'];
const FREE_VIDEO_MODELS = ['minimax-h3'];
const PREMIUM_VIDEO_MODELS = ['seedance-2.0', 'veo', 'wan', 'wan-fast', 'wan-pro', 'nova-reel'];
const FALLBACK_VIDEO_RESOLUTIONS = ['480p', '720p', '1k', '1080p', '2k', '4k'];
const VIDEO_RES_FREE = ['480p', '720p'];
const VIDEO_RES_PREMIUM = ['480p', '720p', '1k', '1080p', '2k', '4k'];

const state = {
  apiKey: '',
  anonymous: false,
  balance: null,
  messages: [],
  history: [],
  lastImage: null,
  lastAudio: null,
  lastVideo: null,
  abort: null,
  generating: false,
  tokensUsed: 0,
  creditRate: 1000 // 1000 tokens ≈ 1 credit (Pollinations 参考换算)
};

const $ = id => document.getElementById(id);

// ---------- 通用工具 ----------

// 统一构造请求头：有 Key 就带 Bearer，匿名则不带
function authHeaders(extra) {
  const h = Object.assign({}, extra || {});
  if (state.apiKey) h['Authorization'] = 'Bearer ' + state.apiKey;
  return h;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function randSeed() {
  return Math.floor(Math.random() * 1000000);
}

// ---------- 可爱助手浮窗 ----------

const assistant = {
  timer: null,
  idle: null,

  say(key, vars, ms) {
    const bubble = $('bubble');
    $('bubbleText').textContent = t(key, vars);
    bubble.classList.remove('hidden');
    void bubble.offsetWidth;
    bubble.classList.add('pop');
    $('mascotBtn').classList.add('bounce');

    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      bubble.classList.remove('pop');
      $('mascotBtn').classList.remove('bounce');
      setTimeout(() => bubble.classList.add('hidden'), 200);
    }, ms || 4200);

    this.resetIdle();
  },

  // 随机小贴士，点小花头像时轮播
  tip() {
    const tips = ['ast.tipSeed', 'ast.tipRatio', 'ast.tipEnhance', 'ast.tipModel', 'ast.firstImage'];
    this.say(tips[Math.floor(Math.random() * tips.length)]);
  },

  // 长时间无操作时主动冒个泡
  resetIdle() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.say('ast.idle'), 90000);
  },

  think(on) {
    $('mascotBtn').classList.toggle('thinking', !!on);
  }
};

// ---------- 登录 / 鉴权 ----------

// 校验 Key：只有 401 代表「key 无效」。
// 官方错误码：401=key 无效/缺失；402=余额不足（key 有效）；403=key 有效但缺某项权限。
// 所以 balance 返回 403/402 时，key 本身是有效的，只是没有读余额权限/余额不够，
// 不应判为「无效」。策略：401 → invalid；200 读余额 → ok；其余非网络错误 → ok。
async function verifyKey(key) {
  const auth = { 'Authorization': 'Bearer ' + key };
  let balanceRes;
  try {
    balanceRes = await fetch(API.base + '/account/balance', { headers: auth });
  } catch (e) {
    return 'neterr';
  }

  // 401 才是唯一明确的「key 无效」信号
  if (balanceRes.status === 401) return 'invalid';

  if (balanceRes.ok) {
    // /account/balance 成功，解析余额
    try {
      const data = await balanceRes.json();
      const raw = data && (data.balance != null ? data.balance
        : (data.data && data.data.balance != null ? data.data.balance : null));
      if (raw != null) state.balance = Number(raw);
    } catch (e) { /* 解析失败不影响登录 */ }
    return 'ok';
  }

  // 402（余额不足）/403（缺 account 权限）/404（老网关无此端点）都说明 key 通过了鉴权
  return 'ok';
}

async function doLogin() {
  const key = $('keyInput').value.trim();
  const msg = $('loginMsg');

  if (!key) {
    msg.className = 'login-msg err';
    msg.textContent = t('login.empty');
    return;
  }

  $('loginSubmitBtn').disabled = true;
  msg.className = 'login-msg';
  msg.textContent = t('login.checking');

  const result = await verifyKey(key);
  $('loginSubmitBtn').disabled = false;

  if (result === 'invalid') {
    msg.className = 'login-msg err';
    msg.textContent = t('login.fail');
    return;
  }
  if (result === 'neterr') {
    msg.className = 'login-msg err';
    msg.textContent = t('login.neterr');
    return;
  }

  msg.className = 'login-msg ok';
  msg.textContent = t('login.ok');

  state.apiKey = key;
  state.anonymous = false;
  if ($('rememberKey').checked) {
    localStorage.setItem(STORE.key, key);
  }
  localStorage.removeItem(STORE.anon);
  setTimeout(enterApp, 420);
}

function doAnonymous() {
  state.apiKey = '';
  state.anonymous = true;
  localStorage.setItem(STORE.anon, '1');
  enterApp();
  toast(t('login.anonNote'));
}

function doLogout() {
  localStorage.removeItem(STORE.key);
  localStorage.removeItem(STORE.anon);
  state.apiKey = '';
  state.anonymous = false;
  state.balance = null;
  state.tokensUsed = 0;
  state.messages = [];
  state.lastImage = null;
  state.lastAudio = null;
  state.lastVideo = null;
  $('keyInput').value = '';
  $('loginMsg').textContent = '';
  updateBadge();
  $('logoutBtn').classList.add('hidden');
  $('loginBtn').classList.remove('hidden');
  updateImageModelSelect();
  updateTextModelSelect();
  updateAudioModelSelect();
  updateVideoModelSelect();
  openLoginModal();
}

function openLoginModal() {
  $('loginModal').classList.remove('hidden');
  setTimeout(() => $('keyInput').focus(), 100);
}

function closeLoginModal() {
  $('loginModal').classList.add('hidden');
}

function enterApp() {
  closeLoginModal();

  updateBadge();
  updateNeedKeyVisibility();
  $('loginBtn').classList.add('hidden');
  $('logoutBtn').classList.remove('hidden');
  loadModels();
  renderHistory();
  setTimeout(() => assistant.say('ast.welcome'), 700);
}

function updateBadge() {
  const badge = $('tierBadge');
  if (state.anonymous) {
    badge.textContent = t('tier.anon');
    badge.className = 'badge gray';
    badge.classList.remove('hidden');
  } else {
    let parts = [t('tier.key')];
    if (state.balance != null) {
      parts.push(state.balance.toFixed(2) + ' ' + t('tier.credits'));
    }
    if (state.tokensUsed > 0) {
      parts.push('· ' + fmtTokens(state.tokensUsed));
    }
    badge.textContent = parts.join(' ');
    badge.className = 'badge green';
    badge.classList.remove('hidden');
  }
}

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

// ---------- 模型列表 ----------

// 新版接口拿不到就退回预置列表，保证界面永远可用
async function loadModels() {
  updateImageModelSelect();
  updateTextModelSelect();
  updateAudioModelSelect();
  updateVideoModelSelect();

  try {
    const res = await fetch(API.base + '/image/models', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      const list = normalizeModels(data);
      if (list.length && state.apiKey) updateImageModelSelect(list);
    }
  } catch (e) { /* 静默回退 */ }

  try {
    const res = await fetch(API.base + '/v1/models', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      const list = normalizeModels(data);
      if (list.length && state.apiKey) updateTextModelSelect(list);
    }
  } catch (e) { /* 静默回退 */ }

  try {
    const res = await fetch(API.base + '/audio/models', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      const list = normalizeModels(data);
      if (list.length && state.apiKey) updateAudioModelSelect(list);
    }
  } catch (e) { /* 静默回退 */ }

  try {
    const res = await fetch(API.base + '/video/models', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      const list = normalizeModels(data);
      if (list.length && state.apiKey) updateVideoModelSelect(list);
    }
  } catch (e) { /* 静默回退 */ }
}

const IMG_RATIO_FREE = ['512x512','768x768','1024x1024','1024x768','768x1024','1280x720','720x1280'];
const IMG_RATIO_PREMIUM = ['512x512','768x768','1024x1024','1024x768','768x1024','1280x720','720x1280','1536x1024','1024x1536','2048x1024','1024x2048','2048x2048'];

function updateImageModelSelect(apiList) {
  const sel = $('imgModel');
  const ratioSel = $('imgRatio');
  const ratioHint = $('ratioHint');
  const modelHint = $('modelHint');

  if (state.apiKey) {
    const list = apiList || FALLBACK_IMAGE_MODELS;
    fillSelectWithBadges(sel, list, 'gptimage');
    // 已登录：解锁全分辨率选项
    fillRatioSelect(ratioSel, IMG_RATIO_PREMIUM, '1024x1024');
    ratioHint.textContent = t('img.ratioPremium');
    ratioHint.style.color = 'var(--ok)';
  } else {
    // 未登录：只显示免费模型
    fillSelect(sel, FREE_IMAGE_MODELS, 'flux');
    fillRatioSelect(ratioSel, IMG_RATIO_FREE, '1024x1024');
    ratioHint.textContent = '';
  }
  updateModelHint();
}

function fillRatioSelect(sel, ratios, preferred) {
  sel.innerHTML = '';
  const ratioLabels = {
    '512x512': '1:1 · 512×512',
    '768x768': '1:1 · 768×768',
    '1024x1024': '1:1 · 1024×1024',
    '1024x768': '4:3 · 1024×768',
    '768x1024': '3:4 · 768×1024',
    '1280x720': '16:9 · 1280×720',
    '720x1280': '9:16 · 720×1280',
    '1536x1024': '3:2 · 1536×1024',
    '1024x1536': '2:3 · 1024×1536',
    '2048x1024': '2:1 · 2048×1024',
    '1024x2048': '1:2 · 1024×2048',
    '2048x2048': '1:1 · 2048×2048'
  };
  ratios.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = ratioLabels[r] || r;
    sel.appendChild(opt);
  });
  if (ratios.includes(preferred)) sel.value = preferred;
}

// 兼容三种返回形态：字符串数组 / 对象数组 / OpenAI 风格 {data:[...]}
function normalizeModels(data) {
  let arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
  return arr
    .map(m => typeof m === 'string' ? m : (m.id || m.name || m.model))
    .filter(Boolean);
}

function fillSelect(sel, list, preferred) {
  sel.innerHTML = '';
  list.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  if (list.includes(preferred)) sel.value = preferred;
}

// 带模型标签的填充：为 premium 模型添加 🌟 前缀，未登录时禁用付费模型
function fillSelectWithBadges(sel, list, preferred) {
  sel.innerHTML = '';
  list.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    const isPremium = PREMIUM_IMAGE_MODELS.includes(name);
    opt.textContent = isPremium ? '🌟 ' + name : name;
    if (!state.apiKey && isPremium) {
      opt.disabled = true;
      opt.textContent += ' 🔒';
    }
    sel.appendChild(opt);
  });
  if (list.includes(preferred)) sel.value = preferred;
}

function updateModelHint() {
  const model = $('imgModel').value;
  const hint = $('modelHint');
  if (!hint) return;
  if (!state.apiKey && PREMIUM_IMAGE_MODELS.includes(model)) {
    hint.textContent = t('img.modelNeedKey');
    hint.style.color = 'var(--danger)';
  } else if (PREMIUM_IMAGE_MODELS.includes(model) && state.apiKey) {
    hint.textContent = t('img.modelPremium');
    hint.style.color = 'var(--ok)';
  } else {
    hint.textContent = '';
  }
}

function updateTextModelSelect(apiList) {
  const sel = $('txtModel');
  const hint = $('txtModelHint');
  if (state.apiKey) {
    const list = apiList || FALLBACK_TEXT_MODELS;
    fillSelectWithBadgesForType(sel, list, PREMIUM_TEXT_MODELS, 'openai-large', 'txt');
    hint.textContent = '';
  } else {
    fillSelect(sel, FREE_TEXT_MODELS, 'openai');
    hint.textContent = '';
  }
}

function updateAudioModelSelect(apiList) {
  const sel = $('audModel');
  const hint = $('audModelHint');
  if (state.apiKey) {
    const list = apiList || FALLBACK_AUDIO_MODELS;
    fillSelectWithBadgesForType(sel, list, PREMIUM_AUDIO_MODELS, 'elevenlabs', 'aud');
    hint.textContent = '';
  } else {
    fillSelect(sel, FREE_AUDIO_MODELS, 'grok-tts');
    hint.textContent = '';
  }
}

function updateVideoModelSelect(apiList) {
  const sel = $('vidModel');
  const resSel = $('vidRes');
  const modelHint = $('vidModelHint');
  const resHint = $('vidResHint');
  if (state.apiKey) {
    const list = apiList || FALLBACK_VIDEO_MODELS;
    fillSelectWithBadgesForType(sel, list, PREMIUM_VIDEO_MODELS, 'seedance-2.0', 'vid');
    fillSelect(resSel, VIDEO_RES_PREMIUM, '1080p');
    resHint.textContent = t('vid.resPremium');
    resHint.style.color = 'var(--ok)';
    modelHint.textContent = '';
  } else {
    fillSelect(sel, FREE_VIDEO_MODELS, 'minimax-h3');
    fillSelect(resSel, VIDEO_RES_FREE, '720p');
    resHint.textContent = t('vid.resFree');
    resHint.style.color = '';
    modelHint.textContent = '';
  }
}

function fillSelectWithBadgesForType(sel, list, premiumList, preferred, prefix) {
  sel.innerHTML = '';
  list.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    const isPremium = premiumList.includes(name);
    opt.textContent = isPremium ? '🌟 ' + name : name;
    if (!state.apiKey && isPremium) {
      opt.disabled = true;
      opt.textContent += ' 🔒';
    }
    sel.appendChild(opt);
  });
  if (list.includes(preferred)) sel.value = preferred;
}

// ---------- 图片生成 ----------

// 图片是 <img> 直连，无法带请求头，官方支持用 ?key= 传递认证
// gen.pollinations.ai/image 新版端点支持 ?key= 且尊重 width/height（返回全分辨率）
// image.pollinations.ai 旧版端点对 flux 等模型强制降分辨率至 768px
function buildImageUrl(prompt, opts) {
  const p = new URLSearchParams();
  p.set('model', opts.model);
  p.set('width', opts.width);
  p.set('height', opts.height);
  p.set('seed', opts.seed);
  if (opts.negative) p.set('negative', opts.negative);
  if (opts.nologo) p.set('nologo', 'true');
  if (opts.enhance) p.set('enhance', 'true');
  if (opts.priv) p.set('private', 'true');
  if (state.apiKey) p.set('key', state.apiKey);
  else p.set('referrer', location.hostname || 'localhost');
  return API.base + '/image/' + encodeURIComponent(prompt) + '?' + p.toString();
}

function buildLegacyImageUrl(prompt, opts) {
  const p = new URLSearchParams();
  p.set('model', opts.model);
  p.set('width', opts.width);
  p.set('height', opts.height);
  p.set('seed', opts.seed);
  if (opts.negative) p.set('negative', opts.negative);
  if (opts.nologo) p.set('nologo', 'true');
  if (opts.enhance) p.set('enhance', 'true');
  if (opts.priv) p.set('private', 'true');
  p.set('referrer', location.hostname || 'localhost');
  return API.legacyImage + '/prompt/' + encodeURIComponent(prompt) + '?' + p.toString();
}

// 图生图：kontext 模型通过 image 参数接收输入图
function buildEditImageUrl(prompt, imageUrl, opts) {
  const p = new URLSearchParams();
  p.set('model', 'kontext');
  p.set('image', imageUrl);
  p.set('width', opts.width);
  p.set('height', opts.height);
  p.set('seed', opts.seed);
  if (opts.nologo) p.set('nologo', 'true');
  if (state.apiKey) p.set('key', state.apiKey);
  else p.set('referrer', location.hostname || 'localhost');
  return API.legacyImage + '/prompt/' + encodeURIComponent(prompt) + '?' + p.toString();
}

// 文件转 data URL
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// 缩小图片以避免 data URL 过长
async function resizeImage(dataUrl, maxDim) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      if (scale >= 1) { resolve(dataUrl); return; }
      w = Math.round(w * scale);
      h = Math.round(h * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

let imgEditImageData = null; // 当前上传的图生图源图 data URL

async function generateImage(reuseSeed) {
  const prompt = $('imgPrompt').value.trim();
  if (!prompt) {
    $('imgHint').textContent = t('img.needPrompt');
    assistant.say('ast.firstImage');
    return;
  }
  if (state.generating) return;

  const isEditMode = !$('imgEditInput').classList.contains('hidden');
  if (isEditMode && !imgEditImageData) {
    $('imgHint').textContent = t('img.needImage');
    return;
  }

  const model = isEditMode ? 'kontext' : $('imgModel').value;
  let [width, height] = $('imgRatio').value.split('x').map(Number);

  // seedream 官方要求最小 960×960
  if (model === 'seedream' && (width < 960 || height < 960)) {
    width = Math.max(width, 960);
    height = Math.max(height, 960);
    toast(t('img.seedreamNote'));
  }

  if (!reuseSeed) {
    if (!$('imgSeed').value) $('imgSeed').value = randSeed();
  } else {
    $('imgSeed').value = randSeed();
  }
  const seed = Number($('imgSeed').value);

  const opts = {
    model, width, height, seed,
    nologo: $('optNologo').checked,
    enhance: $('optEnhance').checked,
    priv: $('optPrivate').checked,
    negative: $('imgNegPrompt').value.trim()
  };

  state.abort = new AbortController();
  state.generating = true;
  $('imgBtn').disabled = true;
  $('imgBtn').textContent = t('img.generating');
  $('imgHint').textContent = '';
  $('imgActions').classList.add('hidden');
  $('imgStage').innerHTML = '<div class="spinner"></div>';
  assistant.think(true);
  assistant.say('ast.imgStart');

  const started = Date.now();

  try {
    // 图生图：POST 到 image.pollinations.ai/prompt（避免 GET URI 超长）
    // 文生图：有 key 走新版端点（1024+ 全分辨率），无 key 走旧版 GET 端点
    const got = isEditMode
      ? await loadImageFromPost(prompt, imgEditImageData, opts)
      : state.apiKey
        ? await loadImage(buildImageUrl(prompt, opts))
        : await loadImage(legacy);
    const url = got.url;
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    // 新版端点 gen.pollinations.ai/image 会尊重 width/height 参数
    const realW = got.w || width;
    const realH = got.h || height;

    $('imgStage').innerHTML =
      '<img class="result-img" alt="' + escapeHtml(prompt) + '" src="' + url + '">';
    $('imgActions').classList.remove('hidden');
    $('imgMeta').textContent = model + ' · ' + realW + '×' + realH + ' · seed ' + seed + ' · ' + secs + 's';
    $('imgHint').textContent = t('img.done');

    state.lastImage = { url, prompt, model, width: realW, height: realH, seed };
    pushHistory({ type: 'image', prompt, model, seed, size: realW + 'x' + realH, url, at: Date.now() });

    assistant.say(secs > 12 ? 'ast.imgSlow' : 'ast.imgDone', { s: secs });
  } catch (e) {
    // 图片走 <img> 加载，拿不到状态码；任何用户都可能被限流
    const msg = state.apiKey ? t('img.fail') : t('img.rate');
    $('imgStage').innerHTML = '<div class="stage-empty">' + msg + '</div>';
    $('imgHint').textContent = msg;
    assistant.say(state.apiKey ? 'ast.imgFail' : 'ast.rate');
    // 无论是否有 key，都禁用按钮并倒计时
    let remaining = state.apiKey ? 10 : 15;
    state.generating = false;
    assistant.think(false);
    $('imgBtn').disabled = true;
    $('imgBtn').textContent = t('img.retryWait', { n: remaining });
    const interval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        $('imgBtn').disabled = false;
        $('imgBtn').textContent = t('img.generate');
      } else {
        $('imgBtn').textContent = t('img.retryWait', { n: remaining });
      }
    }, 1000);
  }
}

// ---------- 音频生成 ----------

function buildAudioUrl(text, opts) {
  const p = new URLSearchParams();
  p.set('text', text);
  p.set('model', opts.model);
  if (opts.voice) p.set('voice', opts.voice);
  p.set('response_format', opts.format || 'mp3');
  if (opts.instructions) p.set('instructions', opts.instructions);
  p.set('key', state.apiKey);
  return API.base + '/audio/' + encodeURIComponent(text) + '?' + p.toString();
}

async function generateAudio(reuse) {
  const text = $('audText').value.trim();
  const model = $('audModel').value;
  const voice = $('audVoice').value;
  const format = $('audFormat').value;
  const instructions = $('audInstruct').value.trim();

  if (state.generating) return;
  if (!text) {
    $('audHint').textContent = t('aud.needText');
    return;
  }

  $('audStage').innerHTML = '<div class="spinner"></div>';
  $('audActions').classList.add('hidden');
  $('audHint').textContent = '';
  $('audBtn').disabled = true;
  $('audBtn').textContent = t('aud.generating');
  assistant.think(true);

  const started = Date.now();
  const url = buildAudioUrl(reuse && state.lastAudio ? state.lastAudio.prompt : text, {
    model, voice, format, instructions
  });

  try {
    // 匿名模式 audio/video 强制要 Key，显示提示
    if (!state.apiKey) {
      throw new Error('no-key');
    }
    const resp = await fetch(url, { signal: state.abort.signal });
    if (!resp.ok) throw new Error('http ' + resp.status);
    const blob = await resp.blob();
    const local = URL.createObjectURL(blob);
    $('audStage').innerHTML =
      '<audio controls class="result-audio" src="' + local + '">' +
      '<p class="stage-empty" data-i18n="aud.empty">生成的语音会出现在这里</p></audio>';
    $('audActions').classList.remove('hidden');
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    $('audMeta').textContent = model + ' · ' + format + ' · ' + secs + 's';
    $('audHint').textContent = t('aud.done');
    assistant.say(reuse ? 'ast.audioDone' : 'ast.audioDone', { s: secs });
    state.lastAudio = { url: local, prompt: text, model, voice, format, instructions };
    pushHistory({ type: 'audio', prompt: text, model, seed: null, size: format, url: local, at: Date.now() });
  } catch (e) {
    const msg = e.message === 'no-key' ? t('need.key') : (state.apiKey ? t('aud.fail') : t('aud.rate'));
    $('audStage').innerHTML = '<div class="stage-empty">' + msg + '</div>';
    $('audHint').textContent = msg;
    assistant.say(state.apiKey ? 'ast.imgFail' : 'ast.rate');
  } finally {
    state.generating = false;
    assistant.think(false);
    $('audBtn').disabled = false;
    $('audBtn').textContent = t('aud.generate');
  }
}

// ---------- 视频生成 ----------

function buildVideoUrl(prompt, opts) {
  const p = new URLSearchParams();
  p.set('prompt', prompt);
  p.set('model', opts.model);
  if (opts.resolution) p.set('resolution', opts.resolution);
  if (opts.duration) p.set('duration', opts.duration);
  if (opts.aspectRatio) p.set('aspectRatio', opts.aspectRatio);
  if (opts.audio) p.set('audio', 'true');
  if (opts.seed != null) p.set('seed', opts.seed);
  p.set('key', state.apiKey);
  return API.base + '/video/' + encodeURIComponent(prompt) + '?' + p.toString();
}

async function generateVideo(reuse) {
  if (!state.apiKey) {
    $('vidStage').innerHTML = '<div class="stage-empty">' + t('need.key') + '</div>';
    $('vidHint').textContent = t('need.key');
    return;
  }
  if (state.generating) return;
  const prompt = $('vidPrompt').value.trim();
  const model = $('vidModel').value;
  const resolution = $('vidRes').value;
  const duration = Number($('vidDur').value);
  const aspectRatio = $('vidRatio').value;
  const audio = $('vidAudio').checked;
  const seed = randSeed();

  if (!prompt) {
    $('vidHint').textContent = t('vid.needPrompt');
    return;
  }

  $('vidStage').innerHTML = '<div class="spinner"></div>';
  $('vidActions').classList.add('hidden');
  $('vidHint').textContent = '';
  $('vidBtn').disabled = true;
  $('vidBtn').textContent = t('vid.generating');
  state.abort = new AbortController();
  assistant.think(true);

  const started = Date.now();
  const url = buildVideoUrl(reuse && state.lastVideo ? state.lastVideo.prompt : prompt, {
    model, resolution, duration, aspectRatio, audio, seed
  });

  try {
    const resp = await fetch(url, { signal: state.abort.signal, headers: authHeaders() });
    if (!resp.ok) throw new Error('http ' + resp.status);
    const blob = await resp.blob();
    const local = URL.createObjectURL(blob);
    $('vidStage').innerHTML =
      '<video controls class="result-video" src="' + local + '" playsinline></video>';
    $('vidActions').classList.remove('hidden');
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    $('vidMeta').textContent = model + ' · ' + resolution + ' · ' + duration + 's · ' + secs + 's';
    $('vidHint').textContent = t('vid.done');
    assistant.say(reuse ? 'ast.videoDone' : 'ast.videoDone', { s: secs });
    state.lastVideo = { url: local, prompt, model, resolution, duration, aspectRatio, audio };
    pushHistory({ type: 'video', prompt, model, seed, size: resolution, url: local, at: Date.now() });
  } catch (e) {
    const msg = state.apiKey ? t('vid.fail') : t('vid.rate');
    $('vidStage').innerHTML = '<div class="stage-empty">' + msg + '</div>';
    $('vidHint').textContent = msg;
    assistant.say(state.apiKey ? 'ast.imgFail' : 'ast.rate');
    let remaining = state.apiKey ? 10 : 15;
    $('vidBtn').disabled = true;
    $('vidBtn').textContent = t('vid.retryWait', { n: remaining });
    const interval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(interval);
        $('vidBtn').disabled = false;
        $('vidBtn').textContent = t('vid.generate');
      } else {
        $('vidBtn').textContent = t('vid.retryWait', { n: remaining });
      }
    }, 1000);
  } finally {
    state.generating = false;
    assistant.think(false);
  }

// ---------- 音频/视频的 Key 可见性 ----------

function updateNeedKeyVisibility() {
  const visible = !state.apiKey;
  $('audioNeedKey').classList.toggle('hidden', !visible);
  $('videoNeedKey').classList.toggle('hidden', !visible);
}

// 图生图 POST 请求（避免 GET URI 超长）
// image.pollinations.ai/prompt POST 返回直接图片二进制流（Content-Type: image/jpeg）
async function loadImageFromPost(prompt, imageUrl, opts) {
  const body = {
    model: 'kontext',
    image: imageUrl,
    width: opts.width,
    height: opts.height,
    seed: opts.seed,
    nologo: opts.nologo,
    ...(opts.negative ? { negative: opts.negative } : {})
  };
  const headers = { 'Content-Type': 'application/json' };
  if (state.apiKey) headers['Authorization'] = 'Bearer ' + state.apiKey;

  const url = API.legacyImage + '/prompt';
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error('HTTP ' + res.status);

  // 响应是直接图片二进制流，转成 blob URL
  const blob = await res.blob();
  const objUrl = URL.createObjectURL(blob);
  return loadImage(objUrl);
}

// 单个 URL 加载，回传真实尺寸
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

async function downloadImage() {
  if (!state.lastImage) return;
  try {
    const res = await fetch(state.lastImage.url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pollinations-' + state.lastImage.seed + '.jpg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    window.open(state.lastImage.url, '_blank');
  }
}

async function downloadAudio() {
  if (!state.lastAudio) return;
  try {
    const res = await fetch(state.lastAudio.url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pollinations-audio-' + Date.now() + '.mp3';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    window.open(state.lastAudio.url, '_blank');
  }
}

async function downloadVideo() {
  if (!state.lastVideo) return;
  try {
    const res = await fetch(state.lastVideo.url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pollinations-video-' + Date.now() + '.mp4';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    window.open(state.lastVideo.url, '_blank');
  }
}

// ---------- 文本对话 ----------

function renderChat() {
  const box = $('chatBox');
  if (!state.messages.length) {
    box.innerHTML = '<div class="chat-empty">' + t('txt.empty') + '</div>';
    return;
  }
  box.innerHTML = state.messages.map((m, i) => {
    // 流式回复在首个 token 到达前是空的，给个占位免得出现空气泡
    const body = m.content
      ? escapeHtml(m.content).replace(/\n/g, '<br>')
      : '<span class="msg-pending">' + t('txt.thinking') + '</span>';
    return '<div class="msg ' + m.role + '">' +
      '<div class="msg-body">' + body + '</div>' +
      (m.role === 'assistant' && m.content
        ? '<button class="copy-btn" data-copy="' + i + '">' + t('txt.copy') + '</button>'
        : '') +
    '</div>';
  }).join('');
  box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  const input = $('txtInput');
  const text = input.value.trim();
  if (!text || state.generating) return;

  state.messages.push({ role: 'user', content: text });
  input.value = '';
  input.style.height = 'auto';
  renderChat();

  const payload = {
    model: $('txtModel').value,
    messages: [],
    temperature: Number($('txtTemp').value),
    stream: true
  };
  const sys = $('txtSystem').value.trim();
  if (sys) payload.messages.push({ role: 'system', content: sys });
  payload.messages = payload.messages.concat(
    state.messages.map(m => ({ role: m.role, content: m.content }))
  );

  state.generating = true;
  state.abort = new AbortController();
  $('sendBtn').classList.add('hidden');
  $('stopBtn').classList.remove('hidden');
  assistant.think(true);

  state.messages.push({ role: 'assistant', content: '' });
  const idx = state.messages.length - 1;
  renderChat();

  const signal = state.abort.signal;
  // 实测旧版 text.pollinations.ai 匿名更稳定，故匿名优先旧版；有 Key 则优先新版
  const chain = state.apiKey
    ? [API.base + '/v1/chat/completions', API.legacyText + '/openai']
    : [API.legacyText + '/openai', API.base + '/v1/chat/completions'];

  let result = false;
  for (const endpoint of chain) {
    result = await streamChat(endpoint, payload, idx);
    if (result === true || signal.aborted) break;
  }

  if (!state.messages[idx].content) {
    if (signal.aborted) {
      state.messages.splice(idx, 1);
    } else {
      state.messages[idx].content = result === 'ratelimit' ? t('txt.rate') : (result === 'unauth' ? t('txt.unauth') : t('txt.fail'));
      assistant.say(result === 'ratelimit' ? 'ast.rate' : (result === 'unauth' ? 'ast.imgFail' : 'ast.imgFail'));
    }
  } else {
    assistant.say('ast.textDone');
    if (state.tokensUsed > 0) {
      const credits = (state.tokensUsed / state.creditRate).toFixed(2);
      toast(t('ast.tokenCount', { n: fmtTokens(state.tokensUsed), c: credits }));
    }
    pushHistory({
      type: 'text',
      prompt: text,
      model: payload.model,
      reply: state.messages[idx].content.slice(0, 200),
      at: Date.now()
    });
  }

  renderChat();
  state.generating = false;
  state.abort = null;
  assistant.think(false);
  $('sendBtn').classList.remove('hidden');
  $('stopBtn').classList.add('hidden');
}

// SSE 流式读取，逐字上屏
// 返回 true=成功；'ratelimit'=被限流；false=其他失败(可回退)
async function streamChat(endpoint, payload, idx) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: state.abort.signal
    });

    // 实测：匿名调用会间歇性返回 401/429，属于限流而非 Key 无效
    if (res.status === 401 || res.status === 429) {
      // 区分"限流"和"无权限"：读取响应体判断
      try {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) {
          const body = await res.json();
          const msg = body && (body.message || (body.error && body.error.message) || '');
          if (msg && (msg.includes('session') || msg.includes('token') || msg.includes('permission'))) {
            return 'unauth';
          }
        }
      } catch (e) { /* ignore */ }
      return 'ratelimit';
    }
    if (!res.ok || !res.body) return false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const data = s.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const choice = json.choices && json.choices[0];
          if (!choice) continue;
          // 只取 content；旧版端点还会推 reasoning(思维链)，不能混进正文
          const delta = choice.delta
            ? choice.delta.content
            : (choice.message && choice.message.content);
          if (delta) {
            state.messages[idx].content += delta;
            renderChat();
          }
          const usage = json.usage;
          if (usage && usage.total_tokens) state.tokensUsed += usage.total_tokens;
        } catch (e) { /* 跳过不完整分片 */ }
      }
    }
    return state.messages[idx].content ? true : false;
  } catch (e) {
    if (e.name === 'AbortError') {
      toast(t('txt.stopped'));
      return true;
    }
    return false;
  }
}

// ---------- 历史记录 ----------

function pushHistory(item) {
  state.history.unshift(item);
  state.history = state.history.slice(0, 50);
  try {
    localStorage.setItem(STORE.hist, JSON.stringify(state.history));
  } catch (e) { /* 超配额忽略 */ }
  renderHistory();
}

function renderHistory() {
  const list = $('histList');
  $('histCount').textContent = t('hist.count', { n: state.history.length });

  if (!state.history.length) {
    list.innerHTML = '<div class="stage-empty">' + t('hist.empty') + '</div>';
    return;
  }

  list.innerHTML = state.history.map((h, i) => {
    const time = new Intl.DateTimeFormat(currentLang, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    }).format(new Date(h.at));

    const thumb = h.type === 'image'
      ? '<img class="hist-thumb" src="' + h.url + '" alt="">'
      : h.type === 'audio'
        ? '<div class="hist-thumb aud">♪</div>'
        : h.type === 'video'
          ? '<div class="hist-thumb vid">▶</div>'
          : '<div class="hist-thumb txt">T</div>';

    const sub = h.type === 'image'
      ? h.model + ' · ' + h.size + ' · seed ' + h.seed
      : h.type === 'audio'
        ? h.model + ' · ' + (h.size || '')
        : h.type === 'video'
          ? h.model + ' · ' + h.size + ' · ' + (h.duration || '') + 's'
          : h.model + ' · ' + escapeHtml(h.reply || '');

    return '<div class="hist-item">' + thumb +
      '<div class="hist-info">' +
        '<div class="hist-prompt">' + escapeHtml(h.prompt) + '</div>' +
        '<div class="hist-sub">' + sub + '</div>' +
        '<div class="hist-time">' + time + '</div>' +
      '</div>' +
      '<button class="btn tiny" data-reuse="' + i + '">' + t('hist.reuse') + '</button>' +
    '</div>';
  }).join('');
}

function reuseHistory(i) {
  const h = state.history[i];
  if (!h) return;
  if (h.type === 'image') {
    $('imgPrompt').value = h.prompt;
    if (h.seed != null) $('imgSeed').value = h.seed;
    switchTab('image');
  } else if (h.type === 'audio') {
    $('audText').value = h.prompt;
    switchTab('audio');
  } else if (h.type === 'video') {
    $('vidPrompt').value = h.prompt;
    switchTab('video');
  } else {
    $('txtInput').value = h.prompt;
    switchTab('text');
  }
  assistant.say('ast.tipSeed');
}

// ---------- 界面交互 ----------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(b => {
    const isActive = b.dataset.tab === name;
    b.classList.toggle('active', isActive);
    // 选中后把该选项卡滚进可视区，避免窄屏横向滚动时点选的文字被裁切
    if (isActive && b.scrollIntoView) {
      try {
        b.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      } catch (_) { /* 老浏览器降级：忽略 */ }
    }
  });
  document.querySelectorAll('.panel').forEach(p =>
    p.classList.toggle('active', p.id === 'panel-' + name));
}

function applyTheme(theme) {
  // CSS 里 :root 已是深色，浅色靠 data-theme="light" 覆盖
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORE.theme, theme);
  $('themeBtn').textContent = theme === 'dark' ? '☀️' : '🌙';
  $('themeBtn').title = t(theme === 'dark' ? 'top.toLight' : 'top.toDark');
}

function bindEvents() {
  // 登录弹窗
  $('loginSubmitBtn').addEventListener('click', doLogin);
  $('anonBtn').addEventListener('click', doAnonymous);
  $('logoutBtn').addEventListener('click', doLogout);
  $('loginBtn').addEventListener('click', openLoginModal);
  $('keyInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') doLogin();
  });
  $('keyToggle').addEventListener('click', () => {
    const el = $('keyInput');
    el.type = el.type === 'password' ? 'text' : 'password';
  });

  // 弹窗关闭
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', closeLoginModal);
  });
  $('loginModal').querySelector('.modal-backdrop').addEventListener('click', closeLoginModal);

  // 顶栏
  $('langSelect').addEventListener('change', e => setLanguage(e.target.value));
  $('themeBtn').addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  });

  // 标签页
  document.querySelectorAll('.tab').forEach(b =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 图片
  $('imgBtn').addEventListener('click', () => generateImage(false));
  $('againBtn').addEventListener('click', () => generateImage(true));
  $('dlBtn').addEventListener('click', downloadImage);
  $('seedBtn').addEventListener('click', () => { $('imgSeed').value = randSeed(); });
  $('imgModel').addEventListener('change', () => updateModelHint());
  $('txtModel').addEventListener('change', () => {
    const h = $('txtModelHint'); if (!h) return;
    const m = $('txtModel').value;
    if (!state.apiKey && PREMIUM_TEXT_MODELS.includes(m)) { h.textContent = t('txt.modelNeedKey'); h.style.color = 'var(--danger)'; }
    else if (PREMIUM_TEXT_MODELS.includes(m) && state.apiKey) { h.textContent = t('txt.modelPremium'); h.style.color = 'var(--ok)'; }
    else { h.textContent = ''; }
  });
  $('audModel').addEventListener('change', () => {
    const h = $('audModelHint'); if (!h) return;
    const m = $('audModel').value;
    if (!state.apiKey && PREMIUM_AUDIO_MODELS.includes(m)) { h.textContent = t('aud.modelNeedKey'); h.style.color = 'var(--danger)'; }
    else if (PREMIUM_AUDIO_MODELS.includes(m) && state.apiKey) { h.textContent = t('aud.modelPremium'); h.style.color = 'var(--ok)'; }
    else { h.textContent = ''; }
  });
  $('vidModel').addEventListener('change', () => {
    const h = $('vidModelHint'); if (!h) return;
    const m = $('vidModel').value;
    if (!state.apiKey && PREMIUM_VIDEO_MODELS.includes(m)) { h.textContent = t('vid.modelNeedKey'); h.style.color = 'var(--danger)'; }
    else if (PREMIUM_VIDEO_MODELS.includes(m) && state.apiKey) { h.textContent = t('vid.modelPremium'); h.style.color = 'var(--ok)'; }
    else { h.textContent = ''; }
  });

  // 音频
  $('audBtn').addEventListener('click', () => generateAudio(false));
  $('audAgain').addEventListener('click', () => generateAudio(true));
  $('audDl').addEventListener('click', downloadAudio);

  // 视频
  $('vidBtn').addEventListener('click', () => generateVideo(false));
  $('vidAgain').addEventListener('click', () => generateVideo(true));
  $('vidDl').addEventListener('click', downloadVideo);
  $('vidDur').addEventListener('input', e => {
    $('vidDurVal').textContent = e.target.value;
  });

  // 文本
  $('sendBtn').addEventListener('click', sendMessage);
  $('stopBtn').addEventListener('click', () => state.abort && state.abort.abort());
  $('clearBtn').addEventListener('click', () => { state.messages = []; state.tokensUsed = 0; renderChat(); });
  $('txtTemp').addEventListener('input', e => { $('tempVal').textContent = e.target.value; });

  const ta = $('txtInput');
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
  });

  // 复制回复
  $('chatBox').addEventListener('click', e => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const msg = state.messages[Number(btn.dataset.copy)];
    navigator.clipboard.writeText(msg.content).then(() => toast(t('txt.copied')));
  });

  // 历史
  $('histList').addEventListener('click', e => {
    const btn = e.target.closest('[data-reuse]');
    if (btn) reuseHistory(Number(btn.dataset.reuse));
  });
  $('histClear').addEventListener('click', () => {
    state.history = [];
    localStorage.removeItem(STORE.hist);
    renderHistory();
  });

  // 助手
  $('mascotBtn').addEventListener('click', () => assistant.tip());
  makeMascotDraggable();

  // 图生图模式切换
  $('imgModeGen').addEventListener('click', () => {
    $('imgModeGen').classList.add('active');
    $('imgModeEdit').classList.remove('active');
    $('imgEditInput').classList.add('hidden');
  });
  $('imgModeEdit').addEventListener('click', () => {
    $('imgModeEdit').classList.add('active');
    $('imgModeGen').classList.remove('active');
    $('imgEditInput').classList.remove('hidden');
  });

  // 图片上传
  const uploadArea = $('imgUploadArea');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.style.display = 'none';
  uploadArea.appendChild(fileInput);
  uploadArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => handleImgUpload(e.target.files[0]));
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.style.borderColor = 'var(--accent)'; });
  uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; });
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.style.borderColor = '';
    if (e.dataTransfer.files[0]) handleImgUpload(e.dataTransfer.files[0]);
  });

  // 图片格式转换
  const convFileInput = document.createElement('input');
  convFileInput.type = 'file';
  convFileInput.accept = 'image/*';
  convFileInput.style.display = 'none';
  $('convDrop').appendChild(convFileInput);
  $('convDrop').addEventListener('click', () => convFileInput.click());
  convFileInput.addEventListener('change', e => handleConvUpload(e.target.files[0]));
  $('convDrop').addEventListener('dragover', e => { e.preventDefault(); $('convDrop').classList.add('dragover'); });
  $('convDrop').addEventListener('dragleave', () => $('convDrop').classList.remove('dragover'));
  $('convDrop').addEventListener('drop', e => {
    e.preventDefault();
    $('convDrop').classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleConvUpload(e.dataTransfer.files[0]);
  });
  $('convFormat').addEventListener('change', e => {
    $('convQualityRow').classList.toggle('hidden', e.target.value === 'png');
  });
  $('convQuality').addEventListener('input', e => { $('convQVal').textContent = e.target.value; });
  $('convBtn').addEventListener('click', convertImage);

  // 视频格式转换
  const vconvFileInput = document.createElement('input');
  vconvFileInput.type = 'file';
  vconvFileInput.accept = 'video/*';
  vconvFileInput.style.display = 'none';
  $('vconvDrop').appendChild(vconvFileInput);
  $('vconvDrop').addEventListener('click', () => vconvFileInput.click());
  vconvFileInput.addEventListener('change', e => handleVconvUpload(e.target.files[0]));
  $('vconvDrop').addEventListener('dragover', e => { e.preventDefault(); $('vconvDrop').classList.add('dragover'); });
  $('vconvDrop').addEventListener('dragleave', () => $('vconvDrop').classList.remove('dragover'));
  $('vconvDrop').addEventListener('drop', e => {
    e.preventDefault();
    $('vconvDrop').classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleVconvUpload(e.dataTransfer.files[0]);
  });
  // 选 GIF 时隐藏质量档（GIF 走调色板两遍法，与 CRF 无关）
  // WEBP 保留质量档（canvas toBlob quality），并显示"抽帧"说明
  $('vconvFormat').addEventListener('change', e => {
    $('vconvQualityRow').classList.toggle('hidden', e.target.value === 'gif');
    $('vconvWebpTip').classList.toggle('hidden', e.target.value !== 'webp');
  });
  $('vconvBtn').addEventListener('click', convertVideo);

  // 语言切换后重绘动态内容
  document.addEventListener('langchange', () => {
    renderChat();
    renderHistory();
    updateBadge();
    updateNeedKeyVisibility();
    $('themeBtn').title = t(state.theme === 'dark' ? 'top.toLight' : 'top.toDark');
  });

  ['click', 'keydown'].forEach(ev =>
    document.addEventListener(ev, () => assistant.resetIdle(), { passive: true }));
}

// ---------- 助手拖动 ----------

// 根据助手当前在屏幕上的水平位置，决定气泡向左还是向右展开：
//   mascot 在屏幕右半边 → 气泡在左（默认，避免溢出右边界）
//   mascot 在屏幕左半边 → 气泡在右（翻转，避免溢出左边界）
// 切换 .assistant.flip 即可，CSS 负责实际方向与缩放原点。
function updateBubblePosition() {
  const container = $('assistant');
  const rect = container.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  container.classList.toggle('flip', centerX < window.innerWidth / 2);
}

function makeMascotDraggable() {
  const mascot = $('mascotBtn');
  const container = $('assistant');
  let dragging = false, moved = false;
  let startX, startY, origX, origY;

  // 恢复位置
  const saved = localStorage.getItem(STORE.mascot);
  if (saved) {
    try {
      const pos = JSON.parse(saved);
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.left = pos.x + 'px';
      container.style.top = pos.y + 'px';
    } catch (_) {}
  }
  // 初始化即根据恢复后的位置决定气泡朝向
  updateBubblePosition();

  function onDown(e) {
    dragging = true; moved = false;
    const pt = e.touches ? e.touches[0] : e;
    const rect = container.getBoundingClientRect();
    startX = pt.clientX;
    startY = pt.clientY;
    origX = rect.left;
    origY = rect.top;
    container.classList.add('dragging');
    e.preventDefault();
  }

  function onMove(e) {
    if (!dragging) return;
    const pt = e.touches ? e.touches[0] : e;
    const dx = pt.clientX - startX;
    const dy = pt.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;

    const maxX = window.innerWidth - 60;
    const maxY = window.innerHeight - 60;
    const nx = Math.max(0, Math.min(maxX, origX + dx));
    const ny = Math.max(0, Math.min(maxY, origY + dy));

    container.style.right = 'auto';
    container.style.bottom = 'auto';
    container.style.left = nx + 'px';
    container.style.top = ny + 'px';
    // 拖动过程中实时翻转，避免气泡在中途溢出
    updateBubblePosition();
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    container.classList.remove('dragging');
    if (moved) {
      const rect = container.getBoundingClientRect();
      localStorage.setItem(STORE.mascot, JSON.stringify({ x: rect.left, y: rect.top }));
    }
    updateBubblePosition();
  }

  mascot.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  mascot.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);

  // 屏幕尺寸变化（旋转 / 调整窗口）后，原位置可能落到屏幕外或跨越中线，重新判定朝向
  window.addEventListener('resize', updateBubblePosition);
}

// ---------- 图生图上传处理 ----------

async function handleImgUpload(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const area = $('imgUploadArea');
  area.innerHTML = '<div class="spinner" style="width:24px;height:24px"></div>';
  try {
    const raw = await fileToDataURL(file);
    const resized = await resizeImage(raw, 768);
    imgEditImageData = resized;
    area.classList.add('has-image');
    area.innerHTML = '<img src="' + resized + '" alt="input"><br><span style="font-size:12px;color:var(--text-soft)" data-i18n="img.changeImage">点击更换</span>';
  } catch (_) {
    area.innerHTML = t('img.uploadFail');
  }
}

// ---------- 图片格式转换 ----------

let convImageData = null;

async function handleConvUpload(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const drop = $('convDrop');
  drop.innerHTML = '<div class="spinner"></div>';
  try {
    const dataUrl = await fileToDataURL(file);
    convImageData = dataUrl;
    drop.classList.add('dragover');
    drop.innerHTML = '<img src="' + dataUrl + '" alt="preview">';
    $('convPreview').classList.remove('hidden');
  } catch (_) {
    drop.innerHTML = t('tool.convertFail');
  }
}

function convertImage() {
  if (!convImageData) return;
  const format = $('convFormat').value;
  const quality = Number($('convQuality').value) / 100;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const mime = format === 'png' ? 'image/png'
      : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
    c.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'converted.' + format;
      a.click();
      URL.revokeObjectURL(url);
      toast(t('tool.done'));
    }, mime, format === 'png' ? undefined : quality);
  };
  img.src = convImageData;
}

// ---------- 视频格式转换（ffmpeg.wasm，纯前端） ----------
//
// 技术决策（GitHub Pages + Tracking Prevention 兼容）：
//   ffmpeg.wasm 0.12.x 必须在 Worker 里运行 wasm，而浏览器禁止「跨域构造 Worker」
//   （SecurityError，与 CORS 无关，换任何 CDN 源都一样被拦）。
//   解决：把 ffmpeg.js / worker chunk(814.ffmpeg.js) / core(ffmpeg-core.js) 三个
//   小文件本地化到 vendor/ffmpeg/，随站点同源部署。这样 ffmpeg.js 同源 →
//   内部 new Worker 也同源，importScripts(core) 同源，彻底绕开跨域拦截。
//   wasm（约 32MB）不塞进仓库，单独走 CDN：它通过 fetch 加载（带 CORS），
//   跨域可正常加载。
//
//   @ffmpeg/core@0.12.10（单线程 UMD）无需 SharedArrayBuffer，不要求 COOP/COEP，
//   纯静态 GitHub Pages 即可运行。
//
// 支持格式：MP4 (H.264)、WebM (VP9)、GIF（两遍调色板）、WEBP（抽帧导出单张图）

const FFMPEG_CFG = {
  // 主类 UMD（已本地化到 vendor/ffmpeg/，同源加载 → 内部 new Worker 也走同源，
  //   从根上规避浏览器对「跨域 Worker 构造」的拦截，这正是问题根源，与 CDN 源无关）
  ffmpegJS: './vendor/ffmpeg/ffmpeg.js',
  // 核心（core.js / worker chunk 均本地化，经典 worker 里 importScripts 同源执行）
  coreBase: './vendor/ffmpeg/',
  // wasm 单独走 CDN：它通过 fetch 加载（带 CORS），跨域可通；32MB 不塞进仓库
  wasmURL: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.wasm'
};

// 动态注入 <script>，加载 UMD 包（幂等：同一 src 只加载一次）
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[data-ffmpeg="' + src + '"]')) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.ffmpeg = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });
}

// 把 File/Blob 读成 Uint8Array（供 ffmpeg.writeFile 使用）
async function fetchFile(input) {
  if (input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (typeof input === 'string') {
    const resp = await fetch(input);
    return new Uint8Array(await resp.arrayBuffer());
  }
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new Error('fetchFile: unsupported input');
}

let ffmpegInstance = null;
let ffmpegLoading = null;
let ffmpegLastActivity = 0;
let vconvFile = null;

async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;

  ffmpegLoading = (async () => {
    // 1) 加载主类 UMD（同源），暴露 window.FFmpegWASM
    await loadScript(FFMPEG_CFG.ffmpegJS);

    const { FFmpeg } = window.FFmpegWASM;

    // 2) core 用绝对同源 URL（importScripts 的相对基准是 worker 目录，不能用相对路径）
    const coreBase = new URL(FFMPEG_CFG.coreBase, location.href).href;

    // 3) 不传 classWorkerURL → 走经典 worker：ffmpeg.js 同源，new Worker 不被拦截
    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => {
      ffmpegLastActivity = Date.now();
      console.log('[ffmpeg log]', message);
    });
    ffmpeg.on('progress', ({ progress }) => {
      ffmpegLastActivity = Date.now();
      console.log('[ffmpeg progress]', (progress * 100).toFixed(1) + '%');
    });
    await ffmpeg.load({
      coreURL: coreBase + 'ffmpeg-core.js',
      wasmURL: FFMPEG_CFG.wasmURL
    }).catch(e => {
      console.error('[ffmpeg load failed]', e);
      throw e;
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  return ffmpegLoading;
}

// wasm 发生致命错误（如 memory access out of bounds）后 worker 不再回包，
// exec() 的 promise 会永远 pending。用看门狗检测"心跳停止"并主动 reject。
// VP9 -cpu-used 3 编第 1 帧可能慢（20~40s），但 ffmpeg log 每帧都会打 frame=N 行，
// 所以 60 秒静默 = 引擎真死了。真死掉的引擎永远不会再产生任何 log。
const WATCHDOG_IDLE_MS = 60_000;
function execWatched(ffmpeg, args, idleMs = WATCHDOG_IDLE_MS) {
  ffmpegLastActivity = Date.now();
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (Date.now() - ffmpegLastActivity > idleMs) {
        clearInterval(timer);
        reject(new Error('ffmpeg worker 无响应（引擎可能已崩溃），请重试'));
      }
    }, 2000);
  });
  return Promise.race([ffmpeg.exec(args), watchdog]).finally(() => clearInterval(timer));
}

// 致命错误后销毁实例，下次转换重新加载全新引擎
function resetFFmpeg() {
  if (ffmpegInstance) {
    try { ffmpegInstance.terminate(); } catch (_) {}
  }
  ffmpegInstance = null;
  ffmpegLoading = null;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

async function handleVconvUpload(file) {
  if (!file || !file.type.startsWith('video/')) return;
  vconvFile = file;
  const drop = $('vconvDrop');
  drop.classList.add('dragover');
  drop.textContent = file.name + ' · ' + formatBytes(file.size);
  // 预览：URL.createObjectURL 是同步的，可直接赋给 video.src
  const video = $('vconvPreviewVideo');
  video.src = URL.createObjectURL(file);
  $('vconvPreview').classList.remove('hidden');
}

async function convertVideo() {
  if (!vconvFile) return;
  const format = $('vconvFormat').value;
  const crf = $('vconvQuality').value; // 18 / 23 / 28
  const btn = $('vconvBtn');
  const hint = $('vconvHint');

  btn.disabled = true;
  btn.textContent = t('tool.loadingEngine');
  hint.textContent = t('tool.loadingEngine');

  try {
    const ffmpeg = await loadFFmpeg();
    btn.textContent = t('tool.converting');
    hint.textContent = t('tool.converting');

    const ext = (vconvFile.name.split('.').pop() || 'mp4').toLowerCase();
    const inputName = 'input.' + ext;
    const outputName = 'output.' + format;

    // fetchFile 为自实现工具（见上），把 File 读成 Uint8Array 传给 ffmpeg.writeFile
    await ffmpeg.writeFile(inputName, await fetchFile(vconvFile));

    // 不同输出格式的命令：
    //   mp4  - libx264 + yuv420p，CRF 越小质量越高（18≈无损，23 默认，28 较小）
    //   webm - libvpx(VP8) + libvorbis；注意不能用 libvpx-vp9，
    //          单线程 ffmpeg.wasm 编 VP9 会触发 memory access out of bounds（已知问题 #679）
    //          -cpu-used -1 强制最高质量（代价是慢）；crf max-intra-rate -1 禁止关键帧混用不同 CRF
    //   gif  - 调色板 + lanczos 缩放，避免直接转 gif 出现明显色阶断层
    //   webp - 抽帧导出单张 WebP（Canvas API 原生支持，无需 ffmpeg）
    let args;
    if (format === 'gif') {
      // 两遍法：先生成调色板，再用调色板转 gif，能显著减少色阶断层/马赛克
      const palette = 'palette.png';
      const paletteFilter = 'fps=10,scale=480:-1:flags=lanczos,palettegen';
      const useFilter = 'fps=10,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse';
      await execWatched(ffmpeg, ['-i', inputName, '-vf', paletteFilter, palette]);
      await execWatched(ffmpeg, ['-i', inputName, '-i', palette, '-lavfi', useFilter, outputName]);
      try { await ffmpeg.deleteFile(palette); } catch (_) {}
    } else if (format === 'webm') {
      // libvpx-vp9 在单线程 wasm 下偶发 memory access out of bounds（issue #679），
      // 用 -cpu-used 3 平衡速度与质量：默认 6 质量太差，-1 太慢。
      // error-resilient=1 防止帧错误扩散。crf max-intra-rate -1 禁止关键帧混用不同 CRF
      args = ['-i', inputName, '-c:v', 'libvpx-vp9', '-cpu-used', '3', '-crf', crf, '-b:v', '0',
              '-crf max-intra-rate', '-1', '-error-resilient', '1',
              '-c:a', 'libvorbis', '-qscale:a', '6', '-pix_fmt', 'yuv420p', outputName];
      await execWatched(ffmpeg, args);
    } else if (format === 'webp') {
      // WebP：用 ffmpeg 抽一帧，走 Canvas API 原生 export 为 WebP（无损/有损可控）
      const frameName = 'frame.jpg';
      await execWatched(ffmpeg, ['-i', inputName, '-frames:v', '1', '-q:v', '5', frameName]);
      const frameData = await ffmpeg.readFile(frameName);
      try { await ffmpeg.deleteFile(frameName); } catch (_) {}
      const img = await blobToImage(new Blob([frameData.buffer || frameData], { type: 'image/jpeg' }));
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      // 下拉框的 value 是 CRF 语义（越小越好），需反向映射为 toBlob 的 quality（越大越好）
      const crfToQuality = { '18': 0.92, '23': 0.8, '28': 0.6 };
      const quality = crfToQuality[$('vconvQuality').value] || 0.8;
      const blob = await new Promise((resolve, reject) => {
        c.toBlob(b => b ? resolve(b) : reject(new Error('canvas webp export failed')), 'image/webp', quality);
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'frame.webp';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      hint.textContent = '';
      toast(t('tool.done'));
      return;
    } else {
      // mp4 / h.264：-pix_fmt yuv420p 保证浏览器可播；-movflags +faststart 改善流播
      args = ['-i', inputName, '-c:v', 'libx264', '-crf', crf, '-preset', 'medium',
              '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
              '-movflags', '+faststart', outputName];
      await execWatched(ffmpeg, args);
    }

    const data = await ffmpeg.readFile(outputName);
    const mime = format === 'webm' ? 'video/webm' : format === 'gif' ? 'image/gif' : 'video/mp4';
    const blob = new Blob([data.buffer || data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'converted.' + format;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);

    // 清理虚拟文件系统，避免占用内存
    try { await ffmpeg.deleteFile(inputName); } catch (_) {}
    try { await ffmpeg.deleteFile(outputName); } catch (_) {}

    hint.textContent = '';
    toast(t('tool.done'));
  } catch (e) {
    console.error('[video convert]', e);
    const msg = e && e.message ? e.message : String(e);
    console.error('[video convert] full:', e);
    // wasm 致命错误（RuntimeError / worker 无响应）后引擎已不可用，销毁以便下次重建
    if (e instanceof Error && (e.name === 'RuntimeError' || /无响应|Aborted/i.test(msg))) {
      resetFFmpeg();
    }
    hint.textContent = t('tool.videoConvertFail') + ' (' + msg.slice(0, 80) + ')';
  } finally {
    btn.disabled = false;
    btn.textContent = t('tool.convert');
  }
}

// canvas.toBlob 接受 Blob 作回调参数（现代浏览器），此处额外提供 blob→Image 工具
function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('image decode failed')); };
    img.src = URL.createObjectURL(blob);
  });
}

// ---------- 启动 ----------

function init() {
  // 深色是默认主题，只有浅色才需要写 data-theme
  applyTheme(localStorage.getItem(STORE.theme) || 'dark');
  $('langSelect').value = currentLang;
  applyLanguage();
  bindEvents();

  try {
    state.history = JSON.parse(localStorage.getItem(STORE.hist) || '[]');
  } catch (e) {
    state.history = [];
  }

  $('imgSeed').value = randSeed();

  // 已保存过 Key 或选过匿名，直接进主界面
  const saved = localStorage.getItem(STORE.key);
  if (saved) {
    state.apiKey = saved;
    state.anonymous = false;
    enterApp();
    verifyKey(saved).then(r => {
      if (r === 'invalid') {
        localStorage.removeItem(STORE.key);
        state.apiKey = '';
        state.anonymous = false;
        updateBadge();
        $('loginBtn').classList.remove('hidden');
        $('logoutBtn').classList.add('hidden');
        openLoginModal();
        $('loginMsg').className = 'login-msg err';
        $('loginMsg').textContent = t('login.fail');
      } else if (r === 'ok') {
        updateBadge();
      }
    });
  } else if (localStorage.getItem(STORE.anon)) {
    state.anonymous = true;
    enterApp();
  } else {
    // 首次进入：显示 app 内容 + 登录弹窗
    openLoginModal();
  }
}

document.addEventListener('DOMContentLoaded', init);
