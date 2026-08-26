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
  // 主域名；若 DNS 解析失败会回退到备用
  get base() { return 'https://gen.pollinations.ai'; },
  get legacyImage() { return 'https://image.pollinations.ai'; },
  get legacyText() { return 'https://text.pollinations.ai'; },
  // 备用域名（cloudflare 镜像）
  get fallbackBase() { return 'https://pollinations.ai'; }
};

const STORE = {
  key: 'pl_api_key',
  theme: 'pl_theme',
  hist: 'pl_history',
  anon: 'pl_anon',
  mascot: 'pl_mascot_pos'
};

const FALLBACK_IMAGE_MODELS = ['flux', 'turbo', 'kontext', 'gptimage', 'seedream'];
// 匿名档位服务端实际只授权 sana（image.pollinations.ai/models 返回 ["sana"]）；
// 请求 flux / turbo 不会报错，而是被静默替换成 sana，所以免费列表只列 sana
const FREE_IMAGE_MODELS = ['sana'];
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
  // X 掉弹窗且尚未进入应用时，等同于匿名进入
  if (!state.apiKey && !state.anonymous && !localStorage.getItem(STORE.anon)) {
    state.apiKey = '';
    state.anonymous = true;
    localStorage.setItem(STORE.anon, '1');
    enterApp();
    toast(t('login.anonNote'));
  }
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
      const credits = (state.tokensUsed / state.creditRate).toFixed(2);
      parts.push(fmtTokens(state.tokensUsed) + ' tokens · ' + credits + ' ' + t('tier.credits'));
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

// 生成成功后重新拉取余额：刷新徽章并返回本次消耗的积分（无 Key / 无权限 / 未变 / 增加时返回 null）
async function refreshBalance() {
  if (!state.apiKey) return null;
  try {
    const res = await fetch(API.base + '/account/balance', { headers: authHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data && (data.balance != null ? data.balance
      : (data.data && data.data.balance != null ? data.data.balance : null));
    if (raw == null) return null;
    const prev = state.balance;
    state.balance = Number(raw);
    updateBadge();
    return prev != null && state.balance < prev ? prev - state.balance : null;
  } catch (e) {
    return null;
  }
}

// 每次生成成功后调用：刷新余额，若确有消耗则 toast 提示
function reportSpend() {
  refreshBalance().then(delta => {
    if (delta != null && delta > 0) toast(t('ast.creditSpent', { c: delta.toFixed(2) }));
  });
}

// ---------- 模型列表 ----------

// 新版接口拿不到就退回预置列表，保证界面永远可用
async function loadModels() {
  updateImageModelSelect();
  updateTextModelSelect();
  updateAudioModelSelect();
  updateVideoModelSelect();

  const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));

  try {
    // 匿名时新版端点会 401，用旧版端点查真实授权（匿名通常只返回 ["sana"]）
    const modelsUrl = state.apiKey ? API.base + '/image/models' : API.legacyImage + '/models';
    const res = await Promise.race([fetch(modelsUrl, { headers: authHeaders() }), timeout(5000)]);
    if (res.ok) {
      const data = await res.json();
      const list = normalizeModels(data);
      if (list.length) updateImageModelSelect(list);
    }
  } catch (e) { /* 静默回退 */ }

  try {
    const res = await Promise.race([fetch(API.base + '/v1/models', { headers: authHeaders() }), timeout(5000)]);
    if (res.ok) {
      const data = await res.json();
      const list = normalizeModels(data);
      if (list.length && state.apiKey) updateTextModelSelect(list);
    }
  } catch (e) { /* 静默回退 */ }

  try {
    const res = await Promise.race([fetch(API.base + '/audio/models', { headers: authHeaders() }), timeout(5000)]);
    if (res.ok) {
      const data = await res.json();
      const list = normalizeModels(data);
      if (list.length && state.apiKey) updateAudioModelSelect(list);
    }
  } catch (e) { /* 静默回退 */ }

  try {
    const res = await Promise.race([fetch(API.base + '/video/models', { headers: authHeaders() }), timeout(5000)]);
    if (res.ok) {
      const data = await res.json();
      const list = normalizeModels(data);
      if (list.length && state.apiKey) updateVideoModelSelect(list);
    }
  } catch (e) { /* 静默回退 */ }
}

// 匿名档位服务端按「总像素面积」封顶在 589824 px（=768×768），
// 超出就会被等比缩小改写（1024×1024→768×768、1024×768→886×665）。
// 所以免费列表只放面积在上限内、能被精确兑现的尺寸。
const IMG_RATIO_FREE = ['512x512','768x768','880x660','660x880','1024x576','576x1024'];
const IMG_RATIO_PREMIUM = ['512x512','768x768','1024x1024','1024x768','768x1024','1280x720','720x1280','1536x1024','1024x1536','2048x1024','1024x2048','2048x2048'];
const FREE_PIXEL_BUDGET = 768 * 768;

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
    fillSelect(sel, FREE_IMAGE_MODELS, 'sana');
    fillRatioSelect(ratioSel, IMG_RATIO_FREE, '768x768');
    ratioHint.textContent = t('img.ratioFree');
    ratioHint.style.color = '';
  }
  updateModelHint();
}

function fillRatioSelect(sel, ratios, preferred) {
  const current = sel.value;
  sel.innerHTML = '';
  const ratioLabels = {
    '512x512': '1:1 · 512×512',
    '768x768': '1:1 · 768×768',
    '880x660': '4:3 · 880×660',
    '660x880': '3:4 · 660×880',
    '1024x576': '16:9 · 1024×576',
    '576x1024': '9:16 · 576×1024',
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
  if (ratios.includes(current)) sel.value = current;
  else if (ratios.includes(preferred)) sel.value = preferred;
}

// 兼容三种返回形态：字符串数组 / 对象数组 / OpenAI 风格 {data:[...]}
function normalizeModels(data) {
  let arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
  return arr
    .map(m => typeof m === 'string' ? m : (m.id || m.name || m.model))
    .filter(Boolean);
}

function fillSelect(sel, list, preferred) {
  const current = sel.value;
  sel.innerHTML = '';
  list.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  if (list.includes(current)) sel.value = current;
  else if (list.includes(preferred)) sel.value = preferred;
}

// 带模型标签的填充：为 premium 模型添加 🌟 前缀，未登录时禁用付费模型
function fillSelectWithBadges(sel, list, preferred) {
  const current = sel.value;
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
  if (list.includes(current) && !(PREMIUM_IMAGE_MODELS.includes(current) && !state.apiKey)) sel.value = current;
  else if (list.includes(preferred)) sel.value = preferred;
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

function fillVideoResolutionSelect(sel, list, preferred) {
  const current = sel.value;
  sel.innerHTML = '';
  list.forEach(name => {
    const opt = document.createElement('option');
    const isPremium = PREMIUM_VIDEO_RESOLUTIONS.includes(name);
    opt.value = name;
    opt.textContent = isPremium ? '🌟 ' + name : name;
    if (!state.apiKey && isPremium) {
      opt.disabled = true;
      opt.textContent += ' 🔒';
    }
    sel.appendChild(opt);
  });
  if (list.includes(current) && !(PREMIUM_VIDEO_RESOLUTIONS.includes(current) && !state.apiKey)) sel.value = current;
  else if (list.includes(preferred)) sel.value = preferred;
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
  // 服务端只认 negative_prompt，写成 negative 会被忽略成 "undefined"（EXIF 可验证）
  if (opts.negative) p.set('negative_prompt', opts.negative);
  p.set('quality', 'high');
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
  if (opts.negative) p.set('negative_prompt', opts.negative);
  p.set('quality', 'high');
  if (opts.nologo) p.set('nologo', 'true');
  if (opts.enhance) p.set('enhance', 'true');
  if (opts.priv) p.set('private', 'true');
  p.set('referrer', location.hostname || 'localhost');
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
  // 图生图 kontext 官方要求必须带 API Key；匿名请求会被静默换成占位图
  if (isEditMode && !state.apiKey) {
    $('imgHint').textContent = t('img.editNeedKey');
    toast(t('img.editNeedKey'));
    return;
  }

  const model = isEditMode ? 'kontext' : $('imgModel').value;
  let [width, height] = $('imgRatio').value.split('x').map(Number);

  // 匿名档位有总像素上限，超了服务端会静默改写尺寸。
  // 这里先等比缩到上限内，让显示尺寸和实际拿到的一致。
  if (!state.apiKey && width * height > FREE_PIXEL_BUDGET) {
    const k = Math.sqrt(FREE_PIXEL_BUDGET / (width * height));
    width = Math.round(width * k);
    height = Math.round(height * k);
    toast(t('img.freePixelCap', { w: width, h: height }));
  }

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
    // 图生图：走官方 /v1/images/edits（multipart，必须带 key）
    // 文生图：有 key 走新版端点（尊重 width/height），无 key 走旧版 GET 端点
    const legacy = buildLegacyImageUrl(prompt, opts);
    let got;
    if (isEditMode) {
      got = await loadImageFromEdit(prompt, imgEditImageData, opts);
    } else if (state.apiKey) {
      const apiUrl = buildImageUrl(prompt, opts);
      got = await loadImage(apiUrl);
      got.apiUrl = apiUrl;
    } else {
      const apiUrl = legacy;
      got = await loadImage(apiUrl);
      got.apiUrl = apiUrl;
    }
    const url = got.url;
    const apiUrl = got.apiUrl;
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    // 新版端点 gen.pollinations.ai/image 会尊重 width/height 参数
    const realW = got.w || width;
    const realH = got.h || height;

    $('imgStage').innerHTML =
      '<img class="result-img" alt="' + escapeHtml(prompt) + '" src="' + url + '">';
    $('imgActions').classList.remove('hidden');
    $('imgMeta').textContent = model + ' · ' + realW + '×' + realH + ' · seed ' + seed + ' · ' + secs + 's';
    // 实际返回尺寸和所选不一致时明确告知（匿名用旧端点会被降到 768）
    if (realW !== width || realH !== height) {
      $('imgHint').textContent = t('img.sizeDowngrade', { w: realW, h: realH, rw: width, rh: height });
    } else {
      $('imgHint').textContent = t('img.done');
    }

    state.lastImage = { url, apiUrl: apiUrl || url, prompt, model, width: realW, height: realH, seed };
    // 图生图 apiUrl 为 null（无法复现 GET URL），历史记录用当前显示 url（blob 在同一会话可见，刷新后失效）
    const histUrl = apiUrl || url;
    pushHistory({ type: 'image', prompt, model, seed, size: realW + 'x' + realH, url: histUrl, at: Date.now() });

    assistant.say(secs > 12 ? 'ast.imgSlow' : 'ast.imgDone', { s: secs });
    reportSpend();
    // 成功路径必须自己复位按钮：失败路径走倒计时，不能放在 finally 里统一处理
    state.generating = false;
    assistant.think(false);
    $('imgBtn').disabled = false;
    $('imgBtn').textContent = t('img.generate');
  } catch (e) {
    // 图生图走 fetch，能拿到真实错误信息；文生图走 <img>，拿不到状态码
    let msg;
    if (e && e.timeout) {
      msg = t('img.timeout');
    } else if (isEditMode) {
      msg = e && e.status === 401 ? t('img.editNeedKey')
          : e && e.status === 402 ? t('img.noBalance')
          : (e && e.message) ? t('img.fail') + '（' + e.message + '）'
          : t('img.fail');
    } else {
      msg = state.apiKey ? t('img.fail') : t('img.rate');
    }
    $('imgStage').innerHTML = '<div class="stage-empty">' + escapeHtml(msg) + '</div>';
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
    reportSpend();
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
    reportSpend();
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
}

// ---------- 音频/视频的 Key 可见性 ----------

function updateNeedKeyVisibility() {
  const visible = !state.apiKey;
  $('audioNeedKey').classList.toggle('hidden', !visible);
  $('videoNeedKey').classList.toggle('hidden', !visible);
}

// data URL 转 Blob，用于 multipart 上传
function dataURLToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/:(.*?);/) || [, 'image/jpeg'])[1];
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

// 图生图：官方 OpenAI 兼容图片编辑端点
// POST gen.pollinations.ai/v1/images/edits（multipart/form-data）
// 该端点必须带 API Key；旧的 image.pollinations.ai/prompt POST 会忽略全部参数
// 并静默返回一张固定 768×768 占位图，所以不能再用
async function loadImageFromEdit(prompt, imageDataUrl, opts) {
  const form = new FormData();
  form.append('image', dataURLToBlob(imageDataUrl), 'input.jpg');
  form.append('prompt', prompt);
  form.append('model', 'kontext');
  form.append('size', opts.width + 'x' + opts.height);
  form.append('response_format', 'b64_json');

  const res = await fetch(API.base + '/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + state.apiKey },
    body: form
  });

  if (!res.ok) {
    let detail = 'HTTP ' + res.status;
    try {
      const err = await res.json();
      if (err && err.error && err.error.message) detail = err.error.message;
    } catch (_) {}
    const e = new Error(detail);
    e.status = res.status;
    throw e;
  }

  // 返回 CreateImageResponse：{ created, data: [{ url | b64_json }] }
  const json = await res.json();
  const item = (json.data && json.data[0]) || {};
  const src = item.b64_json
    ? 'data:image/png;base64,' + item.b64_json
    : item.url;
  if (!src) throw new Error('empty image response');

  const got = await loadImage(src);
  got.apiUrl = item.url || null; // b64 结果无可复现的 GET URL
  return got;
}

// 单个 URL 加载，回传真实尺寸
// 必须带超时：服务端偶发挂住时 <img> 既不 onload 也不 onerror，
// promise 永不 settle，会导致按钮永久卡在「生成中」
function loadImage(url, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      img.src = '';
      const err = new Error('image load timeout');
      err.timeout = true;
      reject(err);
    }, timeoutMs);
    img.onload = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ url, w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error('image load failed'));
    };
    img.src = url;
  });
}

async function downloadImage() {
  if (!state.lastImage) return;
  try {
    const res = await fetch(state.lastImage.apiUrl || state.lastImage.url);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pollinations-' + state.lastImage.seed + '.jpg';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) {
    window.open(state.lastImage.apiUrl || state.lastImage.url, '_blank');
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

  let result = { status: false, usage: 0 };
  let responseUsage = 0;
  for (const endpoint of chain) {
    result = await streamChat(endpoint, payload, idx);
    responseUsage += result.usage;
    if (result.status === true || signal.aborted) break;
  }

  if (!state.messages[idx].content) {
    if (signal.aborted) {
      state.messages.splice(idx, 1);
    } else {
      state.messages[idx].content = result.status === 'ratelimit' ? t('txt.rate') : (result.status === 'unauth' ? t('txt.unauth') : t('txt.fail'));
      assistant.say(result.status === 'ratelimit' ? 'ast.rate' : 'ast.imgFail');
    }
  } else {
    assistant.say('ast.textDone');
    if (responseUsage > 0) {
      state.tokensUsed += responseUsage;
      updateBadge();
      toast(t('ast.tokenCount', {
        n: fmtTokens(responseUsage),
        c: (responseUsage / state.creditRate).toFixed(2),
        t: fmtTokens(state.tokensUsed),
        d: (state.tokensUsed / state.creditRate).toFixed(2)
      }));
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
// 返回 { status, usage }：status 为 true=成功 / 'ratelimit'=被限流 / 'unauth'=无权限 / false=其他失败(可回退)
// usage 为本次请求的 token 数（服务端若分片重复推送 usage，取最大值避免重复累计）
async function streamChat(endpoint, payload, idx) {
  let usageTokens = 0;
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
            return { status: 'unauth', usage: usageTokens };
          }
        }
      } catch (e) { /* ignore */ }
      return { status: 'ratelimit', usage: usageTokens };
    }
    if (!res.ok || !res.body) return { status: false, usage: usageTokens };

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
          if (usage && usage.total_tokens) usageTokens = Math.max(usageTokens, usage.total_tokens);
        } catch (e) { /* 跳过不完整分片 */ }
      }
    }
    return { status: state.messages[idx].content ? true : false, usage: usageTokens };
  } catch (e) {
    if (e.name === 'AbortError') {
      toast(t('txt.stopped'));
      return { status: true, usage: usageTokens };
    }
    return { status: false, usage: usageTokens };
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
      ? '<img class="hist-thumb" src="' + (h.url || '') + '" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'hist-thumb\',textContent:\'🖼\'}))">'
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
    // 现在走 multipart 上传，不再受 URL 长度限制，源图可以留更高分辨率，
    // 免得输入图本身成为输出尺寸的上限（1024 输出需要足够的源图细节）
    const resized = await resizeImage(raw, 1536);
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

// ---------- 视频格式转换（浏览器原生 MediaRecorder，纯前端） ----------
//
// 技术决策（放弃 ffmpeg.wasm）：
//   ffmpeg.wasm 在 GitHub Pages 上只能单线程运行（Pages 无法下发 COOP/COEP 头，
//   开不了 SharedArrayBuffer）。单线程下编码期间不投递事件、大文件极慢，且
//   webm(VP8/VP9) 会触发内存越界必崩。多轮修补看门狗仍会误报「引擎崩溃」，
//   故彻底改用浏览器原生方案。
//
//   MediaRecorder + HTMLVideoElement.captureStream()：用浏览器内置的开源编解码器
//   （VP9/VP8=libvpx、Opus 音频，Chromium/Firefox 均内置；H.264/AAC 视浏览器而定）
//   边播放边实时录制转码。它不会「静默卡死」，webm 也不再崩溃。
//   代价：转码耗时≈视频时长（实时录制），但结果稳定、可预期、绝不会假崩溃。
//
// 支持格式：WebM (VP9 / VP8)、MP4 (H.264，视浏览器支持)、动态 WEBP、GIF

// 按目标格式挑选浏览器实际支持的 MediaRecorder mimeType（逐个探测，取第一个支持的）
function pickRecorderMime(format) {
  const candidates = {
    'webm-vp9': ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm'],
    'webm-vp8': ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'],
    'mp4': ['video/mp4;codecs=h264,aac', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4']
  };
  const list = candidates[format] || [];
  for (const m of list) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

// 触发浏览器下载一个 Blob
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let vconvFile = null;

// 用 MediaRecorder 实时录制转码：
//   1) 把上传文件喂进一个隐藏 <video>，captureStream() 拿到音视频轨；
//   2) MediaRecorder 用目标编解码器（VP9/VP8/H.264）边播边编码；
//   3) video 播到结尾 → onended → recorder.stop() → 收齐 chunks 合成 Blob。
// 不存在「静默卡死」：只要视频在播放，录制就在推进；播完必然结束。
// onProgress(0..1) 用 video 的 currentTime/duration 实时上报，进度真实可见。
function recordVideoToFormat(file, mimeType, videoBitsPerSecond, onProgress) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;              // 必须静音，否则自动播放被浏览器拦截
    video.playsInline = true;
    video.preload = 'auto';
    const srcURL = URL.createObjectURL(file);
    video.src = srcURL;

    let recorder = null;
    let stream = null;
    let progTimer = null;
    const chunks = [];
    let settled = false;

    const cleanup = () => {
      if (progTimer) clearInterval(progTimer);
      try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch (_) {}
      try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      try { video.pause(); } catch (_) {}
      URL.revokeObjectURL(srcURL);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      if (progTimer) clearInterval(progTimer);
      // 停止录制并在 onstop 里 resolve（此处不 revoke，交给 onstop 后 cleanup）
    };

    video.onerror = () => fail(new Error('无法解码该视频文件（浏览器不支持此输入格式）'));

    video.onloadedmetadata = () => {
      // captureStream 在部分浏览器叫 mozCaptureStream
      const capture = video.captureStream || video.mozCaptureStream;
      if (!capture) return fail(new Error('当前浏览器不支持 captureStream，请用 Chrome/Edge/Firefox'));
      try {
        stream = capture.call(video);
      } catch (e) {
        return fail(new Error('captureStream 失败：' + (e && e.message ? e.message : e)));
      }

      let rec;
      try {
        const opts = { mimeType };
        if (videoBitsPerSecond) opts.videoBitsPerSecond = videoBitsPerSecond;
        rec = new MediaRecorder(stream, opts);
      } catch (e) {
        return fail(new Error('该格式不被浏览器的录制器支持：' + mimeType));
      }
      recorder = rec;
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
      rec.onerror = (ev) => fail(new Error('录制出错：' + (ev.error && ev.error.name ? ev.error.name : 'unknown')));
      rec.onstop = () => {
        const out = new Blob(chunks, { type: mimeType.split(';')[0] });
        settled = true;
        cleanup();
        if (out.size === 0) return reject(new Error('录制结果为空，可能视频轨道无法捕获'));
        resolve(out);
      };

      video.onended = () => {
        if (onProgress) onProgress(1);
        done();
        try { if (rec.state !== 'inactive') rec.stop(); } catch (_) {}
      };

      rec.start(200); // 每 200ms 触发一次 dataavailable，便于收集
      const p = video.play();
      if (p && p.catch) p.catch(err => fail(new Error('无法自动播放以进行录制：' + (err && err.message ? err.message : err))));

      // 实时进度：currentTime / duration
      progTimer = setInterval(() => {
        if (video.duration && isFinite(video.duration)) {
          const ratio = Math.min(0.99, video.currentTime / video.duration);
          if (onProgress) onProgress(ratio);
        }
      }, 250);
    };
  });
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function encodeVideoAsGif(file, quality, onProgress) {
  return new Promise((resolve, reject) => {
    if (typeof GIF !== 'function') {
      reject(new Error('GIF 编码器加载失败，请刷新页面后重试'));
      return;
    }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const canvas = document.createElement('canvas');
    const srcURL = URL.createObjectURL(file);
    let settled = false;
    let frameTimer = null;
    let seekHandler = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (frameTimer) clearTimeout(frameTimer);
      if (seekHandler) video.removeEventListener('seeked', seekHandler);
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(srcURL);
      fn(value);
    };
    const fail = err => finish(reject, err);
    video.onerror = () => fail(new Error('无法解码该视频文件'));
    video.onloadedmetadata = () => {
      const width = Math.max(1, video.videoWidth);
      const height = Math.max(1, video.videoHeight);
      const scale = Math.min(1, 480 / width);
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const duration = Math.min(video.duration || 0, 60);
      if (!duration) {
        fail(new Error('视频时长无效'));
        return;
      }
      const frameStep = 0.1;
      const frameCount = Math.max(1, Math.ceil(duration / frameStep));
      const gif = new GIF({
        workers: 2,
        quality: { '18': 3, '23': 10, '28': 20 }[quality] || 10,
        width: canvas.width,
        height: canvas.height,
        workerScript: './vendor/gifjs/gif.worker.js'
      });
      gif.on('progress', ratio => {
        if (onProgress) onProgress(0.5 + ratio * 0.5);
      });
      gif.on('error', err => fail(new Error('GIF 编码失败：' + (err && err.message ? err.message : err))));
      gif.on('finished', blob => finish(resolve, blob));
      let frameIndex = 0;
      seekHandler = () => {
        if (settled) return;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        gif.addFrame(canvas, { copy: true, delay: 100 });
        frameIndex += 1;
        if (onProgress) onProgress(frameIndex / frameCount * 0.5);
        if (frameIndex >= frameCount) {
          gif.render();
          return;
        }
        frameTimer = setTimeout(() => {
          video.currentTime = Math.min(duration, frameIndex * frameStep);
        }, 0);
      };
      video.addEventListener('seeked', seekHandler);
      video.currentTime = 0;
    };
    video.src = srcURL;
  });
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
  const format = $('vconvFormat').value;      // webm-vp9 / webm-vp8 / mp4 / gif / webp
  const quality = $('vconvQuality').value;    // 18 / 23 / 28（沿用原有档位语义：越小越好）
  const btn = $('vconvBtn');
  const hint = $('vconvHint');

  btn.disabled = true;
  btn.textContent = t('tool.converting');
  hint.textContent = t('tool.converting');

  try {
    if (format === 'webp') {
      const blob = await encodeVideoAsAnimatedWebp(vconvFile, quality, ratio => {
        hint.textContent = t('tool.converting') + ' ' + Math.round(ratio * 100) + '%';
      });
      triggerDownload(blob, 'converted.webp');
      hint.textContent = '';
      toast(t('tool.done'));
      return;
    }

    if (format === 'gif') {
      const blob = await encodeVideoAsGif(vconvFile, quality, ratio => {
        hint.textContent = t('tool.converting') + ' ' + Math.round(ratio * 100) + '%';
      });
      triggerDownload(blob, 'converted.gif');
      hint.textContent = '';
      toast(t('tool.done'));
      return;
    }

    const mime = pickRecorderMime(format);
    if (!mime) {
      hint.textContent = t('tool.formatUnsupported');
      return;
    }

    // 质量档 → 目标视频码率（bps）。档位越小画质越高 → 码率越大
    const qualityToBitrate = { '18': 8_000_000, '23': 4_000_000, '28': 1_500_000 };
    const bitrate = qualityToBitrate[quality] || 4_000_000;

    const blob = await recordVideoToFormat(vconvFile, mime, bitrate, (ratio) => {
      const pct = Math.round(ratio * 100);
      hint.textContent = t('tool.converting') + ' ' + pct + '%';
    });

    // 输出扩展名：webm-* → webm，mp4 → mp4
    const outExt = format.startsWith('webm') ? 'webm' : 'mp4';
    triggerDownload(blob, 'converted.' + outExt);

    hint.textContent = '';
    toast(t('tool.done'));
  } catch (e) {
    console.error('[video convert]', e);
    const msg = e && e.message ? e.message : String(e);
    hint.textContent = t('tool.videoConvertFail') + ' (' + msg.slice(0, 80) + ')';
  } finally {
    btn.disabled = false;
    btn.textContent = t('tool.convert');
  }
}

function uint24LE(value) {
  return new Uint8Array([value & 255, (value >> 8) & 255, (value >> 16) & 255]);
}

function uint32LE(value) {
  return new Uint8Array([value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255]);
}

function parseWebpChunks(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const size = (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0;
    if (offset + 8 + size > bytes.length) break;
    chunks.push({ type, data: bytes.slice(offset + 8, offset + 8 + size) });
    offset += 8 + size + (size % 2);
  }
  return chunks;
}

async function assembleAnimatedWebp(frames, width, height) {
  const encoder = new TextEncoder();
  const parts = [];
  const vp8x = new Uint8Array(10);
  vp8x[0] = 0x02;
  vp8x.set(uint24LE(width - 1), 4);
  vp8x.set(uint24LE(height - 1), 7);
  parts.push(encoder.encode('VP8X'), uint32LE(vp8x.length), vp8x);
  const anim = new Uint8Array(6);
  parts.push(encoder.encode('ANIM'), uint32LE(anim.length), anim);
  for (const frame of frames) {
    const chunks = parseWebpChunks(await frame.arrayBuffer()).filter(chunk => ['VP8 ', 'VP8L', 'ALPH'].includes(chunk.type));
    if (!chunks.length) throw new Error('浏览器未能编码 WebP 帧');
    const payloadSize = chunks.reduce((size, chunk) => size + 8 + chunk.data.length + chunk.data.length % 2, 16);
    const header = new Uint8Array(16);
    header.set(uint24LE(width - 1), 6);
    header.set(uint24LE(height - 1), 9);
    header.set(uint24LE(frame.duration), 12);
    header[15] = 0x02;
    parts.push(encoder.encode('ANMF'), uint32LE(payloadSize), header);
    for (const chunk of chunks) {
      parts.push(encoder.encode(chunk.type), uint32LE(chunk.data.length), chunk.data);
      if (chunk.data.length % 2) parts.push(new Uint8Array([0]));
    }
  }
  const contentSize = parts.reduce((size, part) => size + part.length, 4);
  const riff = new Uint8Array(12);
  riff.set(encoder.encode('RIFF'), 0);
  riff.set(uint32LE(contentSize), 4);
  riff.set(encoder.encode('WEBP'), 8);
  return new Blob([riff, ...parts], { type: 'image/webp' });
}

function canvasToWebpBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob || blob.type !== 'image/webp') {
        reject(new Error('当前浏览器不支持 WebP 编码，请使用 Chrome/Edge/Firefox'));
        return;
      }
      resolve(blob);
    }, 'image/webp', quality);
  });
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', failed);
      resolve();
    };
    const failed = () => {
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', failed);
      reject(new Error('读取视频帧失败'));
    };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', failed, { once: true });
    video.currentTime = time;
  });
}

function encodeVideoAsAnimatedWebp(file, quality, onProgress) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const canvas = document.createElement('canvas');
    const srcURL = URL.createObjectURL(file);
    const cleanup = () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(srcURL);
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('无法解码该视频文件'));
    };
    video.onloadeddata = async () => {
      try {
        const scale = Math.min(1, 480 / Math.max(1, video.videoWidth));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = canvas.getContext('2d');
        const duration = Math.min(video.duration || 0, 60);
        if (!duration) throw new Error('视频时长无效');
        const frameDelay = 125;
        const frameStep = frameDelay / 1000;
        const frameCount = Math.max(1, Math.ceil(duration / frameStep));
        const webpQuality = { '18': 0.92, '23': 0.8, '28': 0.6 }[quality] || 0.8;
        const frames = [];
        for (let index = 0; index < frameCount; index += 1) {
          const time = Math.min(duration, index * frameStep);
          if (index > 0) await seekVideo(video, time);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frame = await canvasToWebpBlob(canvas, webpQuality);
          frame.duration = frameDelay;
          frames.push(frame);
          if (onProgress) onProgress((index + 1) / frameCount * 0.8);
        }
        const blob = await assembleAnimatedWebp(frames, canvas.width, canvas.height);
        if (onProgress) onProgress(1);
        cleanup();
        resolve(blob);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    video.src = srcURL;
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
