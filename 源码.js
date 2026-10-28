// ==UserScript==
// @name         🎓 学习通 AI 助手 · 自动视频 · DeepSeek 答题
// @namespace    https://lcs.local/cx-ai
// @version      1.0.13
// @description  🔎 当前支持平台：【超星学习通 / 泛雅课程（视频、章节测验、新版作业、旧版作业）】【`.chaoxing.com` 相关系列页面】【部分高校定制域名】。🚀 目前已经具备的主要功能包括：🎬 自动播放未完成任务的课程视频，支持静音播放、暂停后续播、播放停滞自动恢复、视频结束检测以及任务点完成后自动进入下一节；📝 自动识别新版与旧版作业页面，支持单选题、多选题、判断题、填空题和简答题；🤖 调用 DeepSeek 批量生成答案，并根据题目中的真实 A/B/C/D 标签自动选择选项；🧩 支持章节测验与视频弹题处理，减少答题过程中反复中断的问题；🛡️ 对隐藏旧题容器、题目顺序打乱、页面重复加载等常见情况进行了兼容；⚙️ 提供运行、设置、日志和捐赠四个独立面板，可随时查看当前页面、AI 调用次数、任务点状态与错误信息；💾 已作答内容支持本地缓存，减少重复请求；📱 电脑端 Chrome、Edge 等支持 Tampermonkey / 篡改猴的浏览器均可使用。
// @author       Little Code Sauce
// @license      MIT
// @match        *://*.chaoxing.com/*
// @match        *://*.edu.cn/*
// @match        *://*.nbdlib.cn/*
// @match        *://*.hnsyu.net/*
// @match        *://*.gdhkmooc.com/*
// @resource     ttf https://www.forestpolice.org/ttf/2.0/table.json
// @grant        GM_getResourceText
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.deepseek.com
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  if (window.__LCS_CX_AI_BOOTED__) return;
  window.__LCS_CX_AI_BOOTED__ = true;

  /* ======================================================================
   * 0. 基础工具
   * ==================================================================== */
  const VERSION = '1.0.13';
  const CFG_KEY = 'lcs_cx_cfg_v1';
  const CACHE_KEY = 'lcs_cx_cache_v1';
  const LOG_MAX = 160;

  const UW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const IS_TOP = (() => { try { return window.top === window.self; } catch (e) { return false; } })();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  function textOf(el) {
    if (!el) return '';
    const t = el.innerText != null && el.innerText !== '' ? el.innerText : (el.textContent || '');
    return String(t)
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  function hashStr(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = (h1 ^ c) * 16777619 >>> 0;
      h2 = (h2 * 31 + c) >>> 0;
    }
    return (h1.toString(36) + h2.toString(36));
  }

  // 2-gram Dice 相似度，用于选项文本匹配
  function similarity(a, b) {
    const x = String(a || '').replace(/[\s\p{P}]/gu, '');
    const y = String(b || '').replace(/[\s\p{P}]/gu, '');
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
    const grams = new Map();
    for (let i = 0; i < x.length - 1; i++) {
      const g = x.slice(i, i + 2);
      grams.set(g, (grams.get(g) || 0) + 1);
    }
    let hit = 0;
    for (let i = 0; i < y.length - 1; i++) {
      const g = y.slice(i, i + 2);
      const n = grams.get(g) || 0;
      if (n > 0) { grams.set(g, n - 1); hit++; }
    }
    return (2 * hit) / ((x.length - 1) + (y.length - 1));
  }

  /* ======================================================================
   * 1. 配置
   * ==================================================================== */
  const DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    temperature: 0.1,
    rate: 2,
    autoPlay: true,
    autoNext: true,
    autoQuizTab: true,
    mute: true,
    resumeOnPause: true,
    stallRecovery: true,
    quizAI: true,
    autoAnswer: true,
    autoSubmitWork: true,
    autoSubmitExam: false,
    answerShort: true,
    batchSize: 4,
    skipAnswered: true,
    decryptFont: true,
  };

  function gmGet(key, def) {
    try {
      if (typeof GM_getValue === 'function') {
        const v = GM_getValue(key, null);
        return v == null ? def : v;
      }
      const v = localStorage.getItem(key);
      return v == null ? def : v;
    } catch (e) { return def; }
  }
  function gmSet(key, val) {
    try {
      if (typeof GM_setValue === 'function') return GM_setValue(key, val);
      localStorage.setItem(key, val);
    } catch (e) { /* ignore */ }
  }

  let CFG = (function loadCfg() {
    try {
      const raw = gmGet(CFG_KEY, '');
      const obj = raw ? JSON.parse(raw) : {};
      return Object.assign({}, DEFAULTS, obj && typeof obj === 'object' ? obj : {});
    } catch (e) { return Object.assign({}, DEFAULTS); }
  })();
  // 部分课程会直接拒绝高于 2x 的播放，表现为停在首帧或任务点不增加。
  CFG.rate = clamp(Number(CFG.rate) || DEFAULTS.rate, 1, 2);
  gmSet(CFG_KEY, JSON.stringify(CFG));

  let CFG_SIG = JSON.stringify(CFG);
  function saveCfg() {
    CFG_SIG = JSON.stringify(CFG);
    gmSet(CFG_KEY, CFG_SIG);
  }
  function reloadCfg() {
    try {
      const raw = gmGet(CFG_KEY, '');
      if (!raw || raw === CFG_SIG) return false;
      const obj = JSON.parse(raw);
      CFG = Object.assign({}, DEFAULTS, obj || {});
      CFG.rate = clamp(Number(CFG.rate) || DEFAULTS.rate, 1, 2);
      CFG_SIG = JSON.stringify(CFG);
      if (CFG_SIG !== raw) gmSet(CFG_KEY, CFG_SIG);
      return true;
    } catch (e) { return false; }
  }

  const CACHE = (function () {
    try { return JSON.parse(gmGet(CACHE_KEY, '{}')) || {}; } catch (e) { return {}; }
  })();
  let cacheDirty = false;
  function cacheSaveSoon() {
    if (cacheDirty) return;
    cacheDirty = true;
    setTimeout(() => {
      cacheDirty = false;
      try {
        const keys = Object.keys(CACHE);
        if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete CACHE[k]);
        gmSet(CACHE_KEY, JSON.stringify(CACHE));
      } catch (e) { /* ignore */ }
    }, 800);
  }

  /* ======================================================================
   * 2. 运行状态 & 日志
   * ==================================================================== */
  const state = {
    logs: [],
    questions: [],
    currentRate: 1,
    videoCount: 0,
    answering: false,
    answeredOnce: new Set(),
    stats: { asked: 0, filled: 0, failed: 0, cacheHit: 0 },
    chapterDoc: null,
  };

  const logSinks = [];
  function log(msg, type) {
    const entry = { t: Date.now(), msg: String(msg), type: type || 'info' };
    state.logs.push(entry);
    if (state.logs.length > LOG_MAX) state.logs.shift();
    logSinks.forEach((fn) => { try { fn(entry); } catch (e) { /* ignore */ } });
    if (!IS_TOP) {
      try {
        window.top.postMessage({ __lcsLog: 1, entry: entry }, '*');
      } catch (e) { /* ignore */ }
    }
  }

  /* ======================================================================
   * 3. DeepSeek 调用
   * ==================================================================== */
  function gmRequest(opts) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      // 极少数环境没有 GM_xmlhttpRequest，退回 fetch（同源且允许 CORS 时可用）
      return fetch(opts.url, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.data,
      }).then(async (r) => ({ status: r.status, responseText: await r.text() }))
        .catch(() => { throw new Error('网络请求失败'); });
    }
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: opts.timeout || 120000,
        onload: (res) => resolve(res),
        onerror: () => reject(new Error('网络请求失败')),
        ontimeout: () => reject(new Error('请求超时')),
        onabort: () => reject(new Error('请求已取消')),
      });
    });
  }

  async function callDeepSeek(messages, opt) {
    const o = opt || {};
    if (!CFG.apiKey) throw new Error('未配置 DeepSeek API Key（设置页填写）');
    const base = String(CFG.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, '');
    const body = {
      model: CFG.model || 'deepseek-chat',
      messages: messages,
      temperature: typeof CFG.temperature === 'number' ? CFG.temperature : 0.1,
      max_tokens: o.maxTokens || 2048,
      stream: false,
    };
    if (o.json && !/reasoner/i.test(body.model)) {
      body.response_format = { type: 'json_object' };
    }

    const res = await gmRequest({
      method: 'POST',
      url: base + '/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CFG.apiKey,
      },
      data: JSON.stringify(body),
      timeout: o.timeout || 120000,
    });

    let data = null;
    try { data = JSON.parse(res.responseText || '{}'); } catch (e) {
      throw new Error('接口返回非 JSON（HTTP ' + res.status + '）');
    }
    if (res.status < 200 || res.status >= 300) {
      const m = (data && data.error && (data.error.message || data.error.type)) || '';
      if (res.status === 401) throw new Error('API Key 无效（401）');
      if (res.status === 402) throw new Error('账户余额不足（402）');
      if (res.status === 429) throw new Error('请求过于频繁（429），稍后重试');
      throw new Error('接口错误 HTTP ' + res.status + (m ? '：' + m : ''));
    }
    const choice = data && data.choices && data.choices[0];
    const content = (choice && choice.message && choice.message.content) || '';
    if (!content) throw new Error('模型返回为空');
    return content;
  }

  const PROMPT_SYSTEM = [
    '你是一位严谨的高校课程答题助手。用户会给你一份题目 JSON 数组。',
    '请逐题作答，并且**只输出一个 JSON 对象**，不要输出 markdown 代码块、不要任何解释文字。',
    '输出结构：{"answers":[{"id":0,"answer":["B"],"confidence":0.95}]}',
    '规则：',
    '1. 单选题（single）：answer 为单个选项字母数组，例如 ["B"]。',
    '2. 多选题（multi）：answer 为所有正确选项字母数组，例如 ["A","C","D"]。',
    '3. 判断题（judge）：answer 为 ["对"] 或 ["错"]。',
    '4. 填空题（blank）：answer 为按空格顺序排列的字符串数组，例如 ["光合作用","叶绿体"]。',
    '5. 简答题（short）：answer 为一段完整、可直接提交的中文答案（单个元素）。',
    '6. 若题目信息不足，仍按你的最佳判断给出答案，绝不留空。',
    '7. confidence 为 0~1 的小数，表示你的把握程度。',
    '8. 若某题的 encrypted 为 true，表示题干被平台加密字体保护、无法读取，请仅根据题型与选项语义推断最合理的答案。',
  ].join('\n');

  function extractJson(text) {
    let s = String(text || '').trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); } catch (e) { /* fall through */ }
    try {
      return JSON.parse(s.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3'));
    } catch (e) { return null; }
  }

  /* ======================================================================
   * 4. 题目解析
   * ==================================================================== */
  const TYPE_LABEL = {
    single: '单选题', multi: '多选题', judge: '判断题',
    blank: '填空题', short: '简答题', unknown: '未知题型',
  };

  const TYPE_TAG_RE = /[\[【（(]\s*(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|计算题|材料题|分析题|连线题|其他)[^\]】）)]{0,15}[\]】）)]/g;

  function matchTypeTag(text) {
    TYPE_TAG_RE.lastIndex = 0;
    const m = String(text || '').match(TYPE_TAG_RE);
    if (!m) return '';
    const one = m[0].match(/单选题|多选题|判断题|填空题|简答题|论述题|名词解释|计算题|材料题|分析题|连线题|其他/);
    return one ? one[0] : '';
  }

  function stripTypeTag(text) {
    return String(text || '')
      .replace(TYPE_TAG_RE, ' ')
      .replace(/^\s*[\d一二三四五六七八九十]+[\.、,．]\s*/, '')
      .replace(/\s*（\s*\d+(\.\d+)?\s*分\s*）\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function stripOptionLabel(text) {
    return String(text || '')
      .replace(/^\s*[A-Za-z]\s*[\.、,．:：\)）]?\s*/, '')
      .replace(/^\s*[（(]\s*[A-Za-z]\s*[）)]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function optionLabelOf(text, index) {
    const t = String(text || '').trim();
    const m = t.match(/^\s*([A-Za-z])\s*[\.、,．:：\)）]/);
    if (m) return m[1].toUpperCase();
    return String.fromCharCode(65 + index);
  }

  function optionLabelFromElement(optEl, text, index) {
    const num = optEl && optEl.querySelector ? optEl.querySelector('.num_option') : null;
    const numText = textOf(num);
    const numMatch = numText.match(/[A-Za-z]/);
    if (numMatch) return numMatch[0].toUpperCase();

    const aria = String((optEl && optEl.getAttribute && optEl.getAttribute('aria-label')) || '');
    const ariaMatch = aria.match(/^\s*([A-Za-z])(?:\s|[.、,:：)）]|$)/);
    if (ariaMatch) return ariaMatch[1].toUpperCase();

    return optionLabelOf(text, index);
  }

  function detectType(el, options, tag) {
    const t = tag || '';
    if (/多选/.test(t)) return 'multi';
    if (/判断/.test(t)) return 'judge';
    if (/填空/.test(t)) return 'blank';
    if (/简答|论述|名词解释|计算|材料|分析/.test(t)) return 'short';
    if (/单选/.test(t)) return 'single';

    if (el.querySelector('input[type="checkbox"]')) return 'multi';
    if (el.querySelector('input[type="radio"]')) return 'single';
    if (options.length === 2) {
      const texts = options.map((o) => o.text.replace(/\s/g, ''));
      const isJudge = texts.every((x) => /^(对|错|正确|错误|是|否|√|×|T|F|True|False)$/i.test(x));
      if (isJudge) return 'judge';
    }
    if (options.length > 0) return 'single';
    if (el.querySelector('textarea') || el.querySelector('[contenteditable="true"]')) return 'short';
    if (el.querySelector('input[type="text"], input:not([type])')) return 'blank';
    return 'unknown';
  }

  function visible(el) {
    if (!el) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function parseTiMu(el, index) {
    const stemEl = el.querySelector('.fontLabel') || el;
    const rawStem = textOf(stemEl);
    const tag = matchTypeTag(rawStem);

    const optEls = $$('[class*="before-after"]', el).filter((o) => {
      // 排除包裹整个选项区的容器
      return !o.querySelector('[class*="before-after"]');
    });

    const options = optEls.map((o, i) => {
      const tEl = o.querySelector('.fl.after') || o.querySelector('.after') || o;
      const raw = textOf(tEl);
      return {
        label: optionLabelFromElement(o, raw, i),
        text: stripOptionLabel(raw),
        raw: raw,
        el: o,
        input: o.querySelector('input'),
      };
    }).filter((o) => o.text);

    const type = detectType(el, options, tag);
    const inputs = $$('input[type="text"], input:not([type]), textarea', el)
      .filter((x) => !x.disabled && x.type !== 'hidden');

    return {
      index,
      el,
      mode: 'timu',
      type,
      tag,
      stem: stripTypeTag(rawStem),
      options,
      inputs,
      answer: [],
      ok: false,
    };
  }

  function parseQuestionLi(el, index) {
    const h3 = el.querySelector('h3.mark_name, h3');
    const shallow = el.querySelector('.colorShallow');
    let rawStem = textOf(h3 || el);
    let tag = '';
    if (shallow) {
      tag = stripTypeTag(textOf(shallow));
      if (tag) {
        const pos = rawStem.indexOf(textOf(shallow));
        if (pos >= 0) rawStem = rawStem.slice(pos + textOf(shallow).length);
      }
    }
    if (!tag) tag = matchTypeTag(rawStem);

    let optEls = $$('.stem_answer .answerBg', el);
    if (!optEls.length) optEls = $$('.answerBg', el);
    let useUl = false;
    if (!optEls.length) {
      optEls = $$('ul.mark_letter > li', el);
      useUl = true;
    }
    const options = optEls.map((o, i) => {
      const p = useUl ? o : (o.querySelector('.answer_p') || o);
      const raw = textOf(p);
      return {
        label: optionLabelFromElement(o, raw, i),
        text: stripOptionLabel(raw),
        raw: raw,
        el: o,
        input: o.querySelector('input'),
      };
    }).filter((o) => o.text);

    const type = detectType(el, options, tag);
    const inputs = $$('input[type="text"], input:not([type]), textarea', el)
      .filter((x) => !x.disabled && x.type !== 'hidden');

    return {
      index,
      el,
      mode: 'questionLi',
      type,
      tag,
      stem: stripTypeTag(rawStem),
      options,
      inputs,
      answer: [],
      ok: false,
    };
  }

  // 新版章节测验：题干是 div.fontLabel，选项是 li[qid]（before-after / before-after-checkbox）
  function collectNewUiQuestions(root) {
    const labels = $$('.fontLabel', root).filter((el) => {
      if (textOf(el).length <= 3) return false;
      return !!el.querySelector('.newZy_TItle') || /【(单选|多选|判断|填空|简答|论述|名词解释)/.test(textOf(el));
    });
    const optEls = $$('[qid]', root).filter((el) => /^\d+$/.test(String(el.getAttribute('qid') || '')));
    if (!labels.length || !optEls.length) return [];

    const groups = new Map();
    optEls.forEach((el) => {
      const qid = String(el.getAttribute('qid'));
      if (!groups.has(qid)) groups.set(qid, []);
      groups.get(qid).push(el);
    });

    const out = [];
    let index = 0;
    for (const [, els] of groups) {
      const first = els[0];
      // 找这道题前面最近的 fontLabel 当题干
      let labelEl = null;
      for (const l of labels) {
        if (l === first) break;
        if (l.compareDocumentPosition(first) & 4) labelEl = l; // DOCUMENT_POSITION_FOLLOWING
      }
      if (!labelEl) continue;

      const rawStem = textOf(labelEl);
      const tag = matchTypeTag(rawStem);
      const options = els.map((el, i) => {
        const after = el.querySelector('.fl.after, .after') || el;
        const raw = textOf(after);
        return {
          label: optionLabelFromElement(el, raw, i),
          text: stripOptionLabel(raw),
          raw,
          el,
          input: el.querySelector('input'),
        };
      }).filter((o) => o.text);
      if (!options.length) continue;

      const cls = String(els[0].className || '');
      const onclick = String(els[0].getAttribute('onclick') || '');
      const qtype = String(els[0].getAttribute('qtype') || '');
      let type = 'single';
      if (qtype === '3' || options.every((o) => /^(对|错|正确|错误)$/.test(o.text))) type = 'judge';
      else if (/checkbox/i.test(cls) || /Multiple/i.test(onclick) || qtype === '1') type = 'multi';

      out.push({
        index: index++,
        el: labelEl,
        mode: 'newUi',
        type,
        tag,
        stem: stripTypeTag(rawStem),
        options,
        inputs: [],
        answer: [],
        ok: false,
      });
    }
    return out;
  }

  function collectQuestions(doc) {
    const root = doc || document;
    const groups = [];
    const timu = $$('.TiMu', root).map((el, i) => parseTiMu(el, i));
    const qli = $$('.questionLi', root).map((el, i) => parseQuestionLi(el, i));
    groups.push(timu, qli, collectNewUiQuestions(root));

    const viable = groups
      .map((list) => list.filter((q) => q && (
        q.options.length > 0 || q.type === 'blank' || q.type === 'short'
      )))
      .sort((a, b) => b.length - a.length);

    // 同一页面可能混有第三方扩展插入的旧题容器；优先使用有效题目最多的一组。
    return viable.find((list) => list.length > 0) || [];
  }

  /* ======================================================================
   * 5. 字体解密（超星 font-cxsecret）
   *
   * 超星把字体以 base64 内嵌在 <style> 的 @font-face 里，所谓"加密"只是
   * 打乱了「字符码位 → 字形」的映射，字形轮廓本身还是真的。
   * 所以对字形轮廓取指纹（Typr 路径 JSON 的 md5 后 8 位），再查预生成的
   * 「指纹 → 真实字符」表，就能把乱码文本还原。
   * ==================================================================== */
  const FONT_TABLE_URL = 'https://www.forestpolice.org/ttf/2.0/table.json';
  let decryptTried = false;
  let decryptFailed = false;
  let FONT_TABLE = null;
  let fontTablePromise = null;

  function base64ToBuf(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  /* ---------- 最小 TTF 解析（复刻 Typr.js 的 glyphToPath 输出格式） ---------- */
  function ttfParse(buffer) {
    const dv = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    const tagOf = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
    let base = 0;
    try { if (tagOf(0) === 'ttcf') base = dv.getUint32(12); } catch (e) { /* not ttc */ }

    const numTables = dv.getUint16(base + 4);
    const tables = {};
    for (let i = 0; i < numTables; i++) {
      const o = base + 12 + i * 16;
      tables[tagOf(o)] = { offset: dv.getUint32(o + 8), length: dv.getUint32(o + 12) };
    }
    if (!tables.head || !tables.maxp || !tables.loca || !tables.glyf) throw new Error('ttf: missing tables');

    const unitsPerEm = dv.getUint16(tables.head.offset + 18);
    const indexToLocFormat = dv.getInt16(tables.head.offset + 50);
    const numGlyphs = dv.getUint16(tables.maxp.offset + 4);

    const locaOffsets = [];
    for (let i = 0; i <= numGlyphs; i++) {
      locaOffsets.push(indexToLocFormat === 0
        ? dv.getUint16(tables.loca.offset + i * 2) * 2
        : dv.getUint32(tables.loca.offset + i * 4));
    }

    const font = { dv, u8, tables, unitsPerEm, numGlyphs, locaOffsets, cache: Object.create(null) };
    font.codeToGlyph = buildCmapLookup(font);
    return font;
  }

  function buildCmapLookup(font) {
    const dv = font.dv;
    const cm = font.tables.cmap;
    if (!cm) return () => 0;
    const num = dv.getUint16(cm.offset + 2);
    let fmt4 = -1;
    let fmt12 = -1;
    for (let i = 0; i < num; i++) {
      const o = cm.offset + 4 + i * 8;
      const pid = dv.getUint16(o);
      const eid = dv.getUint16(o + 2);
      const sub = cm.offset + dv.getUint32(o + 4);
      const fmt = dv.getUint16(sub);
      if (fmt === 4 && (pid === 3 || pid === 0) && fmt4 < 0) fmt4 = sub;
      if (fmt === 12 && (pid === 3 || pid === 0) && fmt12 < 0) fmt12 = sub;
    }

    if (fmt12 >= 0) {
      const nGroups = dv.getUint32(fmt12 + 12);
      const groups = [];
      for (let i = 0; i < nGroups; i++) {
        const o = fmt12 + 16 + i * 12;
        groups.push([dv.getUint32(o), dv.getUint32(o + 4), dv.getUint32(o + 8)]);
      }
      return function (code) {
        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          if (code >= g[0] && code <= g[1]) return g[2] + (code - g[0]);
        }
        return 0;
      };
    }

    if (fmt4 >= 0) {
      const segX2 = dv.getUint16(fmt4 + 6);
      const segCount = segX2 / 2;
      const endO = fmt4 + 14;
      const startO = endO + segX2 + 2;
      const deltaO = startO + segX2;
      const rangeO = deltaO + segX2;
      return function (code) {
        for (let s = 0; s < segCount; s++) {
          const end = dv.getUint16(endO + s * 2);
          if (code > end) continue;
          const start = dv.getUint16(startO + s * 2);
          if (code < start) return 0;
          const delta = dv.getInt16(deltaO + s * 2);
          const rangeOffset = dv.getUint16(rangeO + s * 2);
          if (rangeOffset === 0) return (code + delta) & 0xffff;
          const gi = rangeO + s * 2 + rangeOffset + (code - start) * 2;
          if (gi + 1 >= font.u8.length) return 0;
          const g = dv.getUint16(gi);
          return g === 0 ? 0 : (g + delta) & 0xffff;
        }
        return 0;
      };
    }
    return () => 0;
  }

  function ttfGlyph(font, gid) {
    if (font.cache[gid] !== undefined) return font.cache[gid];
    const dv = font.dv;
    const u8 = font.u8;
    const start = font.tables.glyf.offset + font.locaOffsets[gid];
    const end = font.tables.glyf.offset + font.locaOffsets[gid + 1];
    let result = null;
    if (end > start) {
      let p = start;
      const noc = dv.getInt16(p); p += 2;
      p += 8;
      if (noc >= 0) {
        const endPts = [];
        for (let i = 0; i < noc; i++) { endPts.push(dv.getUint16(p)); p += 2; }
        const il = dv.getUint16(p); p += 2 + il;
        const n = noc ? endPts[endPts.length - 1] + 1 : 0;
        const flags = [];
        while (flags.length < n) {
          const f = u8[p++];
          flags.push(f);
          if (f & 0x08) {
            let rep = u8[p++];
            while (rep-- > 0) flags.push(f);
          }
        }
        const xs = new Array(n);
        const ys = new Array(n);
        let x = 0;
        for (let i = 0; i < n; i++) {
          const f = flags[i];
          if (f & 0x02) { const d = u8[p++]; x += (f & 0x10) ? d : -d; }
          else if (!(f & 0x10)) { x += dv.getInt16(p); p += 2; }
          xs[i] = x;
        }
        let y = 0;
        for (let i = 0; i < n; i++) {
          const f = flags[i];
          if (f & 0x04) { const d = u8[p++]; y += (f & 0x20) ? d : -d; }
          else if (!(f & 0x20)) { y += dv.getInt16(p); p += 2; }
          ys[i] = y;
        }
        result = { noc, endPts, flags, xs, ys, parts: null };
      } else {
        const parts = [];
        let flags = 0x0001;
        while (flags & 0x0001) {
          flags = dv.getUint16(p); p += 2;
          const glyphIndex = dv.getUint16(p); p += 2;
          let arg1, arg2;
          if (flags & 0x0001) { arg1 = dv.getInt16(p); arg2 = dv.getInt16(p + 2); p += 4; }
          else { arg1 = u8[p]; arg2 = u8[p + 1]; p += 2; }
          const m = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
          if (flags & (0x0008 | 0x0040 | 0x0080)) {
            const sx = dv.getInt16(p) / 16384; p += 2;
            if (flags & 0x0080) { m.a = sx; m.d = dv.getInt16(p) / 16384; p += 2; }
            else if (flags & 0x0040) {
              m.a = sx;
              m.b = dv.getInt16(p) / 16384; p += 2;
              m.c = dv.getInt16(p) / 16384; p += 2;
              m.d = dv.getInt16(p) / 16384; p += 2;
            } else { m.a = sx; m.d = sx; }
          }
          if (!(flags & 0x0002)) { m.tx = arg1; m.ty = arg2; }
          parts.push({ glyphIndex, m });
        }
        result = { noc: -1, endPts: null, flags: null, xs: null, ys: null, parts };
      }
    }
    font.cache[gid] = result;
    return result;
  }

  function ttfGlyphPath(font, gid, depth) {
    const p = { cmds: [], crds: [] };
    const d = depth || 0;
    if (d > 6) return p;
    const gl = ttfGlyph(font, gid);
    if (!gl) return p;

    if (gl.noc > -1) {
      const { endPts, flags, xs, ys } = gl;
      for (let c = 0; c < gl.noc; c++) {
        const i0 = c === 0 ? 0 : endPts[c - 1] + 1;
        const il = endPts[c];
        for (let i = i0; i <= il; i++) {
          const pr = i === i0 ? il : i - 1;
          const nx = i === il ? i0 : i + 1;
          const on = flags[i] & 1;
          const prOn = flags[pr] & 1;
          const nxOn = flags[nx] & 1;
          const x = xs[i], y = ys[i];
          if (i === i0) {
            if (on) {
              if (prOn) { p.cmds.push('M'); p.crds.push(xs[pr], ys[pr]); }
              else { p.cmds.push('M'); p.crds.push(x, y); continue; }
            } else if (prOn) {
              p.cmds.push('M'); p.crds.push(xs[pr], ys[pr]);
            } else {
              p.cmds.push('M'); p.crds.push((xs[pr] + x) / 2, (ys[pr] + y) / 2);
            }
          }
          if (on) {
            if (prOn) { p.cmds.push('L'); p.crds.push(x, y); }
          } else if (nxOn) {
            p.cmds.push('Q'); p.crds.push(x, y, xs[nx], ys[nx]);
          } else {
            p.cmds.push('Q'); p.crds.push(x, y, (x + xs[nx]) / 2, (y + ys[nx]) / 2);
          }
        }
        p.cmds.push('Z');
      }
      return p;
    }

    (gl.parts || []).forEach((part) => {
      const sub = ttfGlyphPath(font, part.glyphIndex, d + 1);
      const m = part.m;
      for (let i = 0; i < sub.crds.length; i += 2) {
        const x = sub.crds[i], y = sub.crds[i + 1];
        p.crds.push(x * m.a + y * m.b + m.tx);
        p.crds.push(x * m.c + y * m.d + m.ty);
      }
      for (let i = 0; i < sub.cmds.length; i++) p.cmds.push(sub.cmds[i]);
    });
    return p;
  }

  /* ---------- md5（路径 JSON 都是 ASCII，够用） ---------- */
  function md5Hex(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(bitLen & 0xff, (bitLen >>> 8) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 24) & 0xff, 0, 0, 0, 0);

    const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    const K = new Array(64);
    for (let i = 0; i < 64; i++) K[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    for (let off = 0; off < bytes.length; off += 64) {
      const M = new Array(16);
      for (let i = 0; i < 16; i++) {
        const o = off + i * 4;
        M[i] = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
      }
      let A = a, B = b, C = c, D = d;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        const tmp = D;
        D = C;
        C = B;
        const x = (A + F + K[i] + M[g]) | 0;
        B = (B + ((x << S[i]) | (x >>> (32 - S[i])))) | 0;
        A = tmp;
      }
      a = (a + A) | 0; b = (b + B) | 0; c = (c + C) | 0; d = (d + D) | 0;
    }
    const hex = (n) => {
      let s = '';
      for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
      return s;
    };
    return hex(a) + hex(b) + hex(c) + hex(d);
  }

  function loadFontTable() {
    if (FONT_TABLE) return Promise.resolve(FONT_TABLE);
    if (fontTablePromise) return fontTablePromise;
    fontTablePromise = (async () => {
      try {
        if (typeof GM_getResourceText === 'function') {
          const txt = GM_getResourceText('ttf');
          if (txt) { FONT_TABLE = JSON.parse(txt); return FONT_TABLE; }
        }
      } catch (e) { /* ignore */ }
      try {
        const cached = gmGet('lcs_cx_ttf', '');
        if (cached) { FONT_TABLE = JSON.parse(cached); return FONT_TABLE; }
      } catch (e) { /* ignore */ }
      const res = await gmRequest({ url: FONT_TABLE_URL, timeout: 60000 });
      if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
      FONT_TABLE = JSON.parse(res.responseText);
      try { gmSet('lcs_cx_ttf', res.responseText); } catch (e) { /* quota */ }
      return FONT_TABLE;
    })().catch(() => null);
    return fontTablePromise;
  }

  async function decryptDocument(doc) {
    decryptFailed = false;
    if (decryptTried || !CFG.decryptFont) return;
    const targets = $$('.font-cxsecret', doc);
    if (!targets.length) return;
    decryptTried = true;

    const styleEl = $$('style', doc).find((s) => (s.textContent || '').includes('font-cxsecret'));
    if (!styleEl) return;
    const m = (styleEl.textContent || '').match(/base64,([A-Za-z0-9+/=\s]+)/);
    if (!m) return;

    const table = await loadFontTable();
    if (!table) {
      decryptFailed = true;
      log('加密字体表加载失败，AI 将按选项推断', 'warn');
      return;
    }

    let font = null;
    try { font = ttfParse(base64ToBuf(m[1])); } catch (e) {
      decryptFailed = true;
      log('加密字体解析失败：' + e.message, 'warn');
      return;
    }

    const map = Object.create(null);
    let hit = 0;
    let total = 0;
    targets.forEach((el) => {
      const chars = new Set(Array.from(el.textContent || ''));
      chars.forEach((ch) => {
        if (map[ch] !== undefined) return;
        map[ch] = ch;
        const cp = ch.codePointAt(0);
        if (cp < 0x20) return;
        total++;
        try {
          const gid = font.codeToGlyph(cp);
          if (!gid) return;
          const path = ttfGlyphPath(font, gid, 0);
          if (!path.cmds.length) return;
          const v = table[md5Hex(JSON.stringify(path)).slice(24)];
          if (v !== undefined) {
            map[ch] = String.fromCodePoint(Number(v));
            hit++;
          }
        } catch (e) { /* ignore */ }
      });
    });

    let changed = 0;
    targets.forEach((el) => {
      const walk = (node) => {
        if (node.nodeType === 3) {
          const next = Array.from(node.nodeValue).map((c) => {
            const r = map[c];
            if (r && r !== c) { changed++; return r; }
            return c;
          }).join('');
          if (next !== node.nodeValue) node.nodeValue = next;
        } else if (node.nodeType === 1 && node.tagName !== 'SCRIPT') {
          Array.from(node.childNodes).forEach(walk);
        }
      };
      walk(el);
      el.classList.remove('font-cxsecret');
    });

    if (changed > 0) log('已解密加密题干 ' + changed + ' 个字（字形命中 ' + hit + '/' + total + '）', 'ok');
    else {
      decryptFailed = true;
      log('题干字体加密未还原（字形命中 ' + hit + '/' + total + '），AI 将按选项推断', 'warn');
    }
  }

  /* ======================================================================
   * 6. 选项选择 & 填答
   * ==================================================================== */
  function isOptionChecked(opt) {
    if (!opt || !opt.el) return false;
    const el = opt.el;
    const input = opt.input || el.querySelector('input[type="radio"],input[type="checkbox"]');
    if (input && input.checked) return true;
    if (el.getAttribute('aria-checked') === 'true') return true;
    if (el.classList.contains('check_answer') || el.classList.contains('check_answer_dx')) return true;
    if (el.querySelector('.check_answer, .check_answer_dx')) return true;
    return false;
  }

  function clickOption(opt) {
    if (!opt || !opt.el) return false;
    if (isOptionChecked(opt)) return true;
    const el = opt.el;
    try {
      el.click();
      if (isOptionChecked(opt)) return true;
      const input = opt.input || el.querySelector('input[type="radio"],input[type="checkbox"]');
      if (input && !input.checked) {
        input.click();
        return isOptionChecked(opt);
      }
      // 有些页面事件绑定在内部 label / span
      const inner = el.querySelector('label, .answer_p, .fl.after, span');
      if (inner) { inner.click(); }
      return isOptionChecked(opt);
    } catch (e) { return false; }
  }

  function pickOptionByAnswer(q, ans) {
    const raw = String(ans == null ? '' : ans).trim();
    if (!raw) return null;
    const norm = raw.replace(/\s/g, '');

    // 判断题优先按语义
    if (q.type === 'judge') {
      const truthy = /^(对|正确|是|√|T|true|right)$/i.test(norm);
      const falsy = /^(错|错误|否|×|F|false|wrong)$/i.test(norm);
      if (truthy || falsy) {
        const hit = q.options.find((o) => (
          truthy
            ? /对|正确|是|√|T$|true/i.test(o.text)
            : /错|错误|否|×|F$|false/i.test(o.text)
        ));
        if (hit) return hit;
      }
    }

    // 单字母 / 多字母
    if (/^[A-Za-z]{1,8}$/.test(norm) && q.options.length > 0) {
      const label = norm.toUpperCase();
      const hit = q.options.find((o) => o.label === label);
      if (hit) return hit;
    }
    if (/^[A-Za-z]+$/.test(norm) && norm.length <= q.options.length) {
      const hits = q.options.filter((o) => norm.toUpperCase().includes(o.label));
      if (hits.length) return hits[0];
    }

    // 文本相似度
    let best = null;
    let bestScore = 0;
    q.options.forEach((o) => {
      const s = similarity(raw, o.text);
      if (s > bestScore) { bestScore = s; best = o; }
    });
    return bestScore >= 0.42 ? best : null;
  }

  function pickOptions(q, answers) {
    const list = Array.isArray(answers) ? answers : [answers];
    const out = [];
    const seen = new Set();

    if (q.type === 'multi') {
      // "ABC" 形式
      const joined = list.map((x) => String(x || '').trim()).join('');
      if (/^[A-Za-z]{2,}$/.test(joined.replace(/[\s,，、;；]/g, ''))) {
        const letters = joined.replace(/[\s,，、;；]/g, '').toUpperCase();
        q.options.forEach((o) => {
          if (letters.includes(o.label) && !seen.has(o.label)) { seen.add(o.label); out.push(o); }
        });
        if (out.length) return out;
      }
    }

    list.forEach((a) => {
      const opt = pickOptionByAnswer(q, a);
      if (opt && !seen.has(opt.label)) { seen.add(opt.label); out.push(opt); }
    });
    return out;
  }

  function setNativeValue(el, value) {
    if (!el) return false;
    try {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
    } catch (e) {
      try { el.value = value; } catch (e2) { return false; }
    }
    try {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    } catch (e) { /* ignore */ }
    return true;
  }

  function setEditorValue(textarea, text) {
    if (!textarea) return false;
    const name = textarea.getAttribute('name') || textarea.id;
    try {
      const UE = UW.UE;
      if (UE && name && typeof UE.getEditor === 'function') {
        const ed = UE.getEditor(name);
        if (ed && typeof ed.setContent === 'function') {
          ed.setContent(text);
          return true;
        }
      }
    } catch (e) { /* ignore */ }
    return setNativeValue(textarea, text);
  }

  function applyAnswer(q) {
    if (!q || !q.answer || !q.answer.length) return false;
    let ok = false;

    if (q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
      const opts = pickOptions(q, q.answer);
      if (opts.length) {
        opts.forEach((o) => { if (clickOption(o)) ok = true; });
      }
      return ok;
    }

    if (q.type === 'blank') {
      const inputs = q.inputs.filter((x) => x.tagName === 'INPUT' || x.tagName === 'TEXTAREA');
      const vals = q.answer.map((x) => String(x == null ? '' : x));
      if (!inputs.length) return false;
      inputs.forEach((inp, i) => {
        const v = vals[i] != null ? vals[i] : vals[vals.length - 1] || '';
        if (inp.tagName === 'TEXTAREA') setEditorValue(inp, v);
        else setNativeValue(inp, v);
        ok = true;
      });
      return ok;
    }

    if (q.type === 'short') {
      const ta = q.el.querySelector('textarea') || q.el.querySelector('[contenteditable="true"]') || q.inputs.find((x) => x.tagName === 'TEXTAREA');
      if (!ta) return false;
      if (ta.getAttribute && ta.getAttribute('contenteditable') === 'true') {
        ta.innerHTML = esc(q.answer[0]);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return setEditorValue(ta, q.answer[0]);
    }

    return false;
  }

  /* ======================================================================
   * 7. AI 答题
   * ==================================================================== */
  function qCacheKey(q) {
    return hashStr(q.type + '|' + q.stem.replace(/\s/g, '') + '|' + q.options.map((o) => o.text).join('|'));
  }

  async function askBatch(batch) {
    const payload = batch.map((q, i) => {
      const item = {
        id: i,
        type: q.type,
        stem: q.stem || '(题干不可读)',
        options: q.options.map((o) => o.label + '. ' + o.text),
      };
      if (q.type === 'blank') item.blanks = q.inputs.length;
      if (q.encrypted) item.encrypted = true;
      return item;
    });

    const userMsg = '请回答下列题目，输出 JSON：\n' + JSON.stringify(payload);
    const content = await callDeepSeek([
      { role: 'system', content: PROMPT_SYSTEM },
      { role: 'user', content: userMsg },
    ], { json: true, maxTokens: 2600, temperature: 0.1 });

    const obj = extractJson(content);
    if (!obj || !Array.isArray(obj.answers)) throw new Error('模型返回格式异常');

    const map = new Map();
    obj.answers.forEach((a) => {
      if (!a || typeof a !== 'object') return;
      const id = Number(a.id);
      let ans = a.answer;
      if (ans == null) ans = a.answers;
      if (typeof ans === 'string') ans = [ans];
      if (!Array.isArray(ans)) return;
      map.set(id, ans.map((x) => String(x == null ? '' : x)));
    });
    return map;
  }

  async function answerAll(questions, opts) {
    const o = opts || {};
    const todo = questions.filter((q) => {
      if (!o.force && CFG.skipAnswered && qHasAnswerInDom(q)) return false;
      return true;
    });
    if (!todo.length) {
      log('没有需要作答的题目（可能已作答）', 'info');
      return { filled: 0, total: 0 };
    }

    log('开始作答，共 ' + todo.length + ' 题', 'info');
    const size = clamp(Number(CFG.batchSize) || 4, 1, 8);
    let filled = 0;

    for (let i = 0; i < todo.length; i += size) {
      const batch = todo.slice(i, i + size);
      let pending = [];

      // 先查缓存
      batch.forEach((q) => {
        const key = qCacheKey(q);
        if (CACHE[key]) { q.answer = CACHE[key]; pending.push(q); state.stats.cacheHit++; }
        else pending.push(q);
      });

      const need = pending.filter((q) => !q.answer.length);
      if (need.length) {
        let remaining = need.slice();
        for (let attempt = 0; attempt < 2 && remaining.length; attempt++) {
          try {
            const map = await askBatch(remaining);
            const stillMissing = [];
            remaining.forEach((q, idx) => {
              const ans = map.get(idx);
              if (ans && ans.length) {
                q.answer = ans;
                q.ok = true;
                CACHE[qCacheKey(q)] = ans;
                cacheSaveSoon();
              } else {
                stillMissing.push(q);
              }
            });
            remaining = stillMissing;
            state.stats.asked++;
          } catch (err) {
            log('AI 请求失败（第 ' + (attempt + 1) + ' 次）：' + err.message, 'error');
            if (attempt === 0) await sleep(1200);
          }
        }
      }

      pending.forEach((q) => {
        if (applyAnswer(q)) { filled++; state.stats.filled++; }
        else state.stats.failed++;
      });

      renderQuestions();
      await sleep(260);
    }

    log('作答完成：已填 ' + filled + ' / ' + todo.length + ' 题', filled ? 'ok' : 'warn');
    return { filled, total: todo.length };
  }

  function qHasAnswerInDom(q) {
    if (q.type === 'single' || q.type === 'multi' || q.type === 'judge') {
      return q.options.some((o) => isOptionChecked(o));
    }
    if (q.type === 'blank') {
      return q.inputs.some((x) => String(x.value || '').trim());
    }
    if (q.type === 'short') {
      const ta = q.el.querySelector('textarea');
      return !!(ta && String(ta.value || '').trim());
    }
    return false;
  }

  /* ======================================================================
   * 8. 提交
   * ==================================================================== */
  function isExamPage() {
    return /exam-ans|\/exam\/test|\/exam-ans\/exam|reVersionTest/.test(location.href);
  }

  function submitWork() {
    const win = UW;
    try {
      win.confirm = () => true;
      win.alert = () => {};
    } catch (e) { /* ignore */ }

    try {
      if (typeof win.btnBlueSubmit === 'function') {
        log('调用页面提交接口 btnBlueSubmit()', 'info');
        win.btnBlueSubmit();
        setTimeout(() => {
          try { if (typeof win.submitCheckTimes === 'function') win.submitCheckTimes(); } catch (e) { /* ignore */ }
        }, 1500);
        return true;
      }
    } catch (e) { /* ignore */ }

    const btn = document.querySelector('#submitBtn, #submitFocus button, .completeBtn, .btnSubmit, a[onclick*="submit"], button[onclick*="submit"]');
    if (btn) {
      log('点击提交按钮', 'info');
      btn.click();
      return true;
    }

    const cand = $$('a, button, input[type="button"], input[type="submit"], div, span').filter((el) => {
      const t = (el.tagName === 'INPUT' ? String(el.value || '') : textOf(el));
      return /^提\s*交$|^交\s*卷$|确认提交/.test(t.replace(/\s+/g, '')) && el.offsetParent !== null;
    });
    if (cand.length) { cand[0].click(); return true; }
    return false;
  }

  /* ======================================================================
   * 9. 视频引擎
   * ==================================================================== */
  const VIDEOS = new Set();
  const attached = new WeakSet();
  let lastUserGesture = 0;
  let stallRecoveryTimer = 0;

  ['pointerdown', 'mousedown', 'touchstart', 'keydown'].forEach((ev) => {
    document.addEventListener(ev, () => { lastUserGesture = Date.now(); }, true);
  });

  function lockPlaybackRate(v) {
    if (v.__lcsRateLocked) return;
    v.__lcsRateLocked = true;
    try {
      let proto = Object.getPrototypeOf(v);
      let desc = null;
      while (proto && !desc) {
        desc = Object.getOwnPropertyDescriptor(proto, 'playbackRate');
        if (!desc) proto = Object.getPrototypeOf(proto);
      }
      if (!desc || !desc.set || !desc.get) return;
      Object.defineProperty(v, 'playbackRate', {
        configurable: true,
        enumerable: false,
        get() { return desc.get.call(this); },
        set(val) {
          const target = clamp(Number(CFG.rate) || 1, 1, 2);
          try { desc.set.call(this, target); } catch (e) { try { desc.set.call(this, val); } catch (e2) { /* ignore */ } }
        },
      });
    } catch (e) { /* ignore */ }
  }

  function enforceRate(v) {
    const target = clamp(Number(CFG.rate) || 1, 1, 2);
    try {
      if (Math.abs((v.playbackRate || 1) - target) > 0.02) v.playbackRate = target;
      state.currentRate = v.playbackRate;
    } catch (e) { /* ignore */ }
    if (CFG.mute) {
      try {
        if (!v.muted) v.muted = true;
        if (v.volume !== 0) v.volume = 0;
      } catch (e) { /* ignore */ }
    }
  }

  // 超星 video.js 会为「倍速检测 / 学习监控」反复调用 pause()，
  // 这里拦截非用户主动的暂停请求，避免播放被反复打断。
  function lockPause(v) {
    if (v.__lcsPauseLocked) return;
    v.__lcsPauseLocked = true;
    let orig;
    try { orig = v.pause.bind(v); } catch (e) { return; }
    v.__lcsOrigPause = orig;
    try {
      v.pause = function () {
        if (v.__lcsAllowPause) { v.__lcsAllowPause = false; return orig(); }
        if (Date.now() - lastUserGesture < 1500) return orig();
        return undefined;
      };
    } catch (e) { /* ignore */ }
  }

  function allowPause(v) {
    try { v.__lcsAllowPause = true; } catch (e) { /* ignore */ }
  }

  function tryPlay(v) {
    if (!CFG.autoPlay) return;
    if (v.__lcsGateBlocked) return;
    if (!v.paused || v.ended) return;
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // 需要用户手势：注册一次性点击后重试
          if (v.__lcsRetryBound) return;
          v.__lcsRetryBound = true;
          const retry = () => { v.__lcsRetryBound = false; tryPlay(v); };
          document.addEventListener('click', retry, { once: true, capture: true });
        });
      }
    } catch (e) { /* ignore */ }
  }

  function kickPlayControl(v) {
    if (!v || v.__lcsGateBlocked || !CFG.autoPlay) return false;
    const now = Date.now();
    if (now - (Number(v.__lcsLastKickAt) || 0) < 6000) return false;
    v.__lcsLastKickAt = now;

    const selectors = [
      '.vjs-big-play-button', '.xgplayer-play', '.xgplayer-start',
      '.prism-play-btn', '.prism-cover-play', '.dplayer-play-icon',
      '.jw-icon-playback', '.ans-video-play', '.play-btn', '.player-play',
      'button[aria-label*="播放"]', '[title*="播放"]',
    ];
    const root = v.closest('.ans-video-player, .video-player, .prism-player, .xgplayer, .video-js') ||
      v.parentElement;
    const candidates = [];
    [root, document].filter(Boolean).forEach((r) => {
      selectors.forEach((sel) => {
        try { candidates.push(...$$(sel, r)); } catch (e) { /* ignore */ }
      });
    });
    const btn = candidates.find((el) => el !== v && visible(el));
    try {
      if (btn) {
        btn.click();
        if (!v.__lcsKickLogged) {
          v.__lcsKickLogged = true;
          log('自动播放未启动，已点击播放器开始按钮', 'warn');
        }
        return true;
      }
      if (visible(v)) {
        v.click();
        if (!v.__lcsKickLogged) {
          v.__lcsKickLogged = true;
          log('自动播放未启动，已点击视频画面重试', 'warn');
        }
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function ensureAutoplay(v) {
    if (!CFG.autoPlay || !v || !v.isConnected || v.__lcsGateBlocked || v.ended) return;
    if (!v.paused) {
      v.__lcsNoStartAt = 0;
      return;
    }
    if (Date.now() - lastUserGesture < 5000) return;
    if (v.readyState === 0 && v.networkState === 2) return;
    const now = Date.now();
    if (!v.__lcsNoStartAt) v.__lcsNoStartAt = now;
    if (now - v.__lcsNoStartAt < 3500) {
      tryPlay(v);
      return;
    }
    tryPlay(v);
    kickPlayControl(v);
  }

  function attachVideo(v) {
    if (attached.has(v)) return;
    attached.add(v);
    VIDEOS.add(v);
    v.__lcsLastTime = 0;
    v.__lcsLastAdvanceAt = Date.now();
    v.__lcsStallRetries = 0;
    lockPlaybackRate(v);
    lockPause(v);

    v.addEventListener('ratechange', () => enforceRate(v));
    v.addEventListener('loadedmetadata', () => {
      v.__lcsSeenReady = true;
      v.__lcsLastAdvanceAt = Date.now();
      enforceRate(v);
      tryPlay(v);
    });
    v.addEventListener('canplay', () => {
      v.__lcsSeenReady = true;
      tryPlay(v);
    });
    v.addEventListener('playing', () => {
      v.__lcsLastAdvanceAt = Date.now();
      v.__lcsStallRetries = 0;
    });
    v.addEventListener('timeupdate', () => {
      const t = Number(v.currentTime) || 0;
      if (t > (Number(v.__lcsLastTime) || 0) + 0.05) {
        v.__lcsLastTime = t;
        v.__lcsLastAdvanceAt = Date.now();
        v.__lcsStallRetries = 0;
      }
    });
    v.addEventListener('ended', () => {
      v.__lcsEndedAt = Date.now();
      log('视频已播放完毕', 'ok');
    });
    v.addEventListener('pause', () => {
      if (v.__lcsGateBlocked) return;
      if (!CFG.resumeOnPause) return;
      if (v.ended) return;
      if (Date.now() - lastUserGesture < 5000) return;
      setTimeout(() => {
        if (v.paused && !v.ended) tryPlay(v);
      }, 1400);
    });
    v.addEventListener('error', () => {
      const er = v.error;
      if (er && !v.__lcsErrorLogged) {
        v.__lcsErrorLogged = true;
        log('播放器报错（代码 ' + er.code + '），等待自动恢复', 'warn');
      }
    });

    enforceRate(v);
    tryPlay(v);
    setTimeout(() => ensureAutoplay(v), 1500);
    log('已接管视频（' + (v.duration ? Math.round(v.duration) + 's' : '时长未知') + '）', 'info');
  }

  function forceResume(v) {
    if (!v || !v.isConnected || v.__lcsGateBlocked || v.ended || v.paused) return;
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* tryPlay handles gesture-only playback */ });
    } catch (e) { /* ignore */ }
  }

  function recoverStalledVideo(v) {
    if (!CFG.stallRecovery || !v || !v.isConnected || v.__lcsGateBlocked) return;
    if (v.ended) {
      v.__lcsLastAdvanceAt = Date.now();
      return;
    }
    if (v.paused) {
      v.__lcsLastAdvanceAt = Date.now();
      ensureAutoplay(v);
      return;
    }

    const now = Date.now();
    const duration = Number(v.duration);
    const current = Number(v.currentTime) || 0;
    if (Number.isFinite(duration) && duration > 0 && current >= duration - 1.5) {
      v.__lcsLastAdvanceAt = now;
      return;
    }

    const lastAdvance = Number(v.__lcsLastAdvanceAt) || now;
    if (now - lastAdvance < 12000) return;

    const retries = Number(v.__lcsStallRetries) || 0;
    if (!v.__lcsLastStallLog || now - v.__lcsLastStallLog > 30000) {
      v.__lcsLastStallLog = now;
      const buffering = v.readyState < 3;
      log(buffering ? '视频缓冲停滞超过 12 秒，正在尝试恢复…' : '视频画面停滞超过 12 秒，正在尝试恢复…', 'warn');
    }

    v.__lcsStallRetries = retries + 1;
    v.__lcsLastAdvanceAt = now;

    if (v.readyState < 3) {
      // 缓冲型卡住只重新请求播放，避免频繁 seek 导致缓冲重新开始。
      forceResume(v);
      return;
    }

    // 解码器偶发卡死：短暂暂停再播放，必要时把播放头向前轻推。
    try {
      allowPause(v);
      v.pause();
      setTimeout(() => {
        try {
          if (retries > 0) {
            const d = Number(v.duration);
            const t = Number(v.currentTime) || 0;
            if (Number.isFinite(d) && d > 0) {
              v.currentTime = Math.min(d - 0.5, t + 0.15);
            }
          }
        } catch (e) { /* ignore */ }
        tryPlay(v);
      }, 350);
    } catch (e) {
      forceResume(v);
    }
  }

  function startStallRecovery() {
    if (stallRecoveryTimer) return;
    stallRecoveryTimer = setInterval(() => {
      VIDEOS.forEach((v) => {
        if (!v.isConnected) {
          VIDEOS.delete(v);
          return;
        }
        recoverStalledVideo(v);
      });
    }, 2000);
  }

  // 只接管“未完成任务点”里的视频。普通资料视频、已完成任务点的回放都不动。
  function videoAllowedByTaskPoint() {
    let win = window;
    let guard = 0;
    while (win && win !== win.top && guard++ < 6) {
      let fe = null;
      try { fe = win.frameElement; } catch (e) { return false; }
      if (!fe) return false;
      let job = null;
      try {
        job = fe.closest ? fe.closest('.ans-job, .ans-attach-online') : null;
        if (!job && fe.parentElement) job = fe.parentElement.closest('.ans-job, .ans-attach-online');
      } catch (e) { job = null; }
      if (job) return !jobFinished(job);
      win = win.parent;
    }
    // 兜底：顶层广播“当前章节有未完成视频任务点”时，允许章节 iframe 里的视频播放
    if (window.__lcsAllowTaskVideo) return true;
    return false;
  }

  function scanVideos() {
    let list = [];
    try { list = Array.from(document.querySelectorAll('video,audio')); } catch (e) { list = []; }
    state.videoCount = list.length;
    if (!videoAllowedByTaskPoint()) {
      // 不是未完成任务点：不接管、不加速；已经接管过的恢复为可暂停并停下。
      list.forEach((v) => {
        try {
          v.__lcsGateBlocked = true;
          allowPause(v);
          if (!v.paused) v.pause();
        } catch (e) { /* ignore */ }
      });
      VIDEOS.forEach((v) => { if (!v.isConnected) VIDEOS.delete(v); });
      return;
    }
    list.forEach((v) => {
      try {
        if (v.__lcsGateBlocked) v.__lcsLastAdvanceAt = Date.now();
        v.__lcsGateBlocked = false;
      } catch (e) { /* ignore */ }
    });
    list.forEach(attachVideo);
    VIDEOS.forEach((v) => { if (!v.isConnected) VIDEOS.delete(v); });
    VIDEOS.forEach(enforceRate);
  }

  function countVideosDeep(win, depth) {
    let n = 0;
    try { n += win.document.querySelectorAll('video,audio').length; } catch (e) { /* ignore */ }
    if (depth <= 0) return n;
    try {
      const frames = win.document.querySelectorAll('iframe');
      for (let i = 0; i < frames.length; i++) {
        try {
          if (frames[i].contentWindow) n += countVideosDeep(frames[i].contentWindow, depth - 1);
        } catch (e) { /* cross-origin */ }
      }
    } catch (e) { /* ignore */ }
    return n;
  }

  /* ======================================================================
   * 10. 视频弹题
   * ==================================================================== */
  const quizState = { el: null, busy: false, done: new WeakSet() };

  function findVisibleQuiz() {
    const list = $$('.ans-videoquiz');
    return list.find((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return r.width > 40 && r.height > 20 && cs.display !== 'none' && cs.visibility !== 'hidden';
    }) || null;
  }

  function parseQuiz(root) {
    const titleEl = root.querySelector('.ans-videoquiz-title, .tkItem_title');
    const stem = stripTypeTag(textOf(titleEl) || textOf(root).slice(0, 120));
    const inputs = $$('input[name="ans-videoquiz-opt"], .ans-videoquiz-opt input', root)
      .filter((i) => i.type === 'radio' || i.type === 'checkbox');
    const options = inputs.map((inp, i) => {
      const holder = inp.closest('label, .ans-videoquiz-opt') || inp.parentElement;
      const raw = textOf(holder);
      return {
        label: optionLabelOf(raw, i),
        text: stripOptionLabel(raw),
        raw: raw,
        el: holder,
        input: inp,
      };
    });
    const type = inputs.length && inputs[0].type === 'checkbox' ? 'multi'
      : (inputs.length === 2 ? 'judge' : 'single');
    return { stem, options, inputs, type, el: root };
  }

  async function handleQuiz(quizEl) {
    if (quizState.busy || quizState.done.has(quizEl)) return;
    quizState.busy = true;
    const q = parseQuiz(quizEl);
    log('检测到视频弹题：' + q.stem.slice(0, 40), 'warn');

    try {
      if (CFG.quizAI && CFG.apiKey && q.stem) {
        const map = await askBatch([q]);
        const ans = map.get(0);
        if (ans && ans.length) q.answer = ans;
      }
      if (!q.answer.length) {
        // 兜底：随便选一个，保证能继续播放
        const pick = q.options[Math.floor(Math.random() * q.options.length)];
        if (pick) q.answer = [pick.label];
        log('弹题未获得答案，随机选择以保证继续播放', 'warn');
      }
      const opts = pickOptions(q, q.answer);
      opts.forEach(clickOption);
      await sleep(500);

      const submit = quizEl.querySelector('#videoquiz-submit');
      if (submit && visible(submit)) { submit.click(); log('弹题已提交', 'ok'); }
      await sleep(900);

      const cont = quizEl.querySelector('#videoquiz-continue');
      if (cont && visible(cont)) { cont.click(); log('弹题已关闭，继续播放', 'ok'); }
      quizState.done.add(quizEl);
    } catch (e) {
      log('弹题处理失败：' + e.message, 'error');
      const cont = quizEl.querySelector('#videoquiz-continue');
      if (cont) cont.click();
      quizState.done.add(quizEl);
    } finally {
      quizState.busy = false;
    }
  }

  function checkQuiz() {
    const el = findVisibleQuiz();
    if (!el) return;
    if (quizState.busy) return;
    if (quizState.done.has(el)) return;
    // 弹题出现时允许播放器暂停，处理完再恢复
    VIDEOS.forEach((v) => {
      try { allowPause(v); if (!v.paused) v.pause(); } catch (e) { /* ignore */ }
    });
    handleQuiz(el);
  }

  /* ======================================================================
   * 11. 章节任务点 & 自动下一节
   * ==================================================================== */
  function chapterFrame() {
    const f = document.querySelector('#iframe') ||
      document.querySelector('iframe[name="iframe"]') ||
      document.querySelector('iframe.ans-insertvideo-online') ||
      null;
    if (!f) return null;
    // 切章节时旧 iframe 内容可能还在，必须确认它属于当前章节
    const cid = (location.href.match(/chapterId=(\d+)/) || [])[1];
    const m = String(f.src || '').match(/knowledgeid=(\d+)/);
    if (cid && m && m[1] !== cid) return null;
    return f;
  }

  function getDocSafe(frame) {
    try { return frame && frame.contentDocument ? frame.contentDocument : null; } catch (e) { return null; }
  }

  const DOC_JOB_RE = /insertdoc|insertbook|insertfile|\.ppt|pdf/i;

  function jobNodes(doc) {
    let nodes = Array.from(doc.querySelectorAll('.ans-attach-online'));
    // 有些版本的视频任务点只有 .ans-job 外壳，没有 .ans-attach-online
    doc.querySelectorAll('.ans-job').forEach((n) => {
      if (!n.querySelector('.ans-attach-online') && !nodes.includes(n)) nodes.push(n);
    });
    return nodes;
  }

  function jobFinished(node) {
    if (!node) return false;
    if (node.classList && node.classList.contains('ans-job-finished')) return true;
    if (node.closest && node.closest('.ans-job-finished')) return true;
    try { return !!node.querySelector('.ans-job-finished'); } catch (e) { return false; }
  }

  // 只有“视频任务点”才需要自动播放；普通插播视频/资料视频不算任务点。
  function isVideoJob(node) {
    try {
      if (/insertvideo|\bvideo\b/i.test(String(node.className || ''))) return true;
      if (node.querySelector && node.querySelector('iframe[src*="insertvideo"], iframe[src*="video"], iframe.ans-insertvideo-online, video, [class*="video"]')) return true;
      return /insertvideo|视频/.test(String(node.innerHTML || '').slice(0, 3000));
    } catch (e) { return false; }
  }

  function isQuizJob(node) {
    try {
      const cls = String(node.className || '');
      const txt = String(node.innerText || '').slice(0, 120);
      return /work|exam|quiz/i.test(cls) || /章节测验|测验|作业|考试/.test(txt);
    } catch (e) { return false; }
  }

  function jobInfo() {
    const f = chapterFrame();
    const doc = getDocSafe(f);
    if (!doc) {
      return { ready: false, total: 0, done: 0, unfinished: [], videoUnfinished: 0, quizUnfinished: 0, docUnfinished: 0, unknown: 0 };
    }
    const all = jobNodes(doc);
    const jobs = all.filter((n) => !DOC_JOB_RE.test(String(n.className || '')));
    const unfinished = jobs.filter((n) => !jobFinished(n));
    const videoJobs = unfinished.filter(isVideoJob);
    const quizJobs = unfinished.filter(isQuizJob);
    const unknownJobs = unfinished.filter((n) => !isVideoJob(n) && !isQuizJob(n));
    return {
      ready: true,
      total: jobs.length,
      done: jobs.length - unfinished.length,
      unfinished,
      videoUnfinished: videoJobs.length,
      quizUnfinished: quizJobs.length,
      docUnfinished: all.length - jobs.length,
      unknown: unknownJobs.length,
    };
  }

  function allJobsFinished() {
    const info = jobInfo();
    return info.ready && info.total > 0 && info.unfinished.length === 0;
  }

  function quizTabExists() {
    const tab = document.querySelector('#dct2');
    return !!tab && tab.offsetParent !== null;
  }

  // 有些课程把“章节测验”任务点渲染成一张卡片而不是 .ans-job，
  // 这里再用页面文字兜底判断是否待完成。
  function quizTabPending() {
    const tab = document.querySelector('#dct2');
    if (!tab || tab.offsetParent === null) return false;
    if (/待完成|未完成|未提交/.test(textOf(tab))) return true;
    // 任务点卡片里的“章节测验”带未完成/去完成标记
    const cards = Array.from(document.querySelectorAll('.ans-job, .ans-attach-online, [class*="job"]')).filter(visible);
    for (const c of cards) {
      const t = textOf(c);
      if (/章节测验|测验|作业/.test(t) && /待完成|未完成|去完成|开始/.test(t)) return true;
    }
    let body = '';
    for (const doc of sameOriginDocs(window, 0)) {
      try { body += '\n' + ((doc.body && doc.body.innerText) || ''); } catch (e) { /* ignore */ }
    }
    return /章节测验[\s\S]{0,40}(待完成|未完成)|(待完成|未完成)[\s\S]{0,40}章节测验/.test(body);
  }

  function activeTab() {
    const t2 = document.querySelector('#dct2');
    const t1 = document.querySelector('#dct1');
    const on = (el) => !!el && /(^|\s)(active|current|on|selected)(\s|$)/.test(String(el.className || ''));
    if (on(t2)) return 2;
    if (on(t1)) return 1;
    return 0;
  }

  // 递归收集所有同源 iframe 文档（学习通测验经常藏在 #iframe 的下一层）
  function sameOriginDocs(win, depth, out) {
    const docs = out || [];
    const d = depth || 0;
    let doc = null;
    try { doc = win.document; } catch (e) { return docs; }
    if (!doc || docs.includes(doc)) return docs;
    docs.push(doc);
    if (d >= 4) return docs;
    let frames = [];
    try { frames = Array.from(doc.querySelectorAll('iframe')); } catch (e) { frames = []; }
    for (const f of frames) {
      try { if (f.contentWindow) sameOriginDocs(f.contentWindow, d + 1, docs); } catch (e) { /* cross-origin */ }
    }
    return docs;
  }

  function findQuizDoc() {
    for (const doc of sameOriginDocs(window, 0)) {
      let el = null;
      try { el = doc.querySelector('.TiMu, .questionLi, [qid]'); } catch (e) { continue; }
      if (!el) continue;
      try { if (visible(el)) return doc; } catch (e) { return doc; }
    }
    return null;
  }

  function quizResultDoc() {
    for (const doc of sameOriginDocs(window, 0)) {
      try {
        const marks = Array.from(doc.querySelectorAll('.mark_answer, .rightAnswerContent')).filter(visible);
        if (marks.length) return doc;
      } catch (e) { /* ignore */ }
      let body = '';
      try { body = (doc.body && doc.body.innerText) || ''; } catch (e) { continue; }
      if (!/我的答案|正确答案|本次成绩/.test(body)) continue;
      // 只认可见的短文本节点，避免把隐藏模板/上次成绩摘要误判成已完成
      let nodes = [];
      try { nodes = Array.from(doc.querySelectorAll('div, span, p, td, li')); } catch (e) { continue; }
      for (const el of nodes) {
        if (!visible(el)) continue;
        const t = textOf(el).replace(/\s+/g, '');
        if (t.length > 40) continue;
        if (/^(我的答案|正确答案|本次成绩)/.test(t)) return doc;
      }
    }
    return null;
  }

  function findConfirmDialog(doc) {
    const docs = [doc || document];
    try {
      if (window.top && window.top.document && window.top.document !== docs[0]) docs.push(window.top.document);
    } catch (e) { /* cross-origin */ }
    for (const d of docs) {
      let nodes = [];
      try { nodes = Array.from(d.querySelectorAll('div, section, form')); } catch (e) { continue; }
      for (const el of nodes) {
        if (!visible(el)) continue;
        const t = textOf(el);
        if (t.length > 400) continue;
        if (/确认提交|确定提交/.test(t)) return el;
      }
    }
    return null;
  }

  function clickConfirmDialog(dialog) {
    if (!dialog) return false;
    const btns = Array.from(dialog.querySelectorAll('button, a, input[type="button"], input[type="submit"], div, span'));
    const labelOf = (b) => (b && b.tagName === 'INPUT' ? String(b.value || '') : textOf(b)).replace(/\s+/g, '');
    const btn = btns.find((b) => visible(b) && /^(提\s*交|确\s*定|确\s*认)$/.test(labelOf(b)));
    if (!btn) return false;
    try { btn.click(); return true; } catch (e) { return false; }
  }

  async function confirmSubmitDialog() {
    for (let i = 0; i < 15; i++) {
      await sleep(700);
      const dlg = findConfirmDialog(document);
      if (dlg && clickConfirmDialog(dlg)) {
        log('已点击提交确认弹窗', 'ok');
        return true;
      }
    }
    return false;
  }

  function isChapterPage() {
    return /mycourse\/studentstudy|knowledge\/cards/.test(location.href) ||
      !!document.querySelector('#prevNextFocusNext') ||
      !!document.querySelector('.nextChapter');
  }

  let lastNextClick = 0;
  let doneStreak = 0;
  const quizVisited = new Set();
  const quizSubmitted = new Set();
  const quizTriedAt = Object.create(null);
  let quizTabBusy = false;
  let lastCid = '';
  let videoZeroSince = 0;
  let videoDoneSince = 0;
  let emptySince = 0;
  let videoSkipped = false;
  let videoClicked = false;
  let unknownSkipped = false;
  let infoLoggedCid = '';

  function currentChapterId() {
    const m = location.href.match(/chapterId=(\d+)/);
    return m ? m[1] : '';
  }

  // 章节测验标签的 onclick 里带的是“测验内容”的章节 id，可能和地址栏 chapterId 不同。
  // 两个 id 都要记为已访问/已提交，否则返回知识学习后会以为这是新章节，再次进入做完的测验。
  function quizTabChapterId() {
    const tab = document.querySelector('#dct2');
    const onclick = String((tab && tab.getAttribute('onclick')) || '');
    const m = onclick.match(/changeDisplayContent\(\s*\d+\s*,\s*\d+\s*,\s*['"](\d+)['"]/);
    return m ? m[1] : '';
  }

  function quizKeys() {
    const out = [];
    const a = currentChapterId();
    const b = quizTabChapterId();
    if (a) out.push(a);
    if (b && !out.includes(b)) out.push(b);
    return out;
  }

  function quizWasVisited() {
    return quizKeys().some((id) => quizVisited.has(id));
  }

  function quizWasSubmitted() {
    return quizKeys().some((id) => quizSubmitted.has(id));
  }

  function quizFrameEl() {
    const frames = $$('iframe');
    for (let i = 0; i < frames.length; i++) {
      try {
        const w = frames[i].contentWindow;
        if (!w) continue;
        const href = w.location.href || '';
        if (/doHomeWorkNew|selectWorkQuestion/.test(href)) return frames[i];
      } catch (e) { /* cross-origin */ }
    }
    return null;
  }

  async function waitQuizDone(maxMs) {
    const t0 = Date.now();
    let sawQuiz = false;
    let lastSubmit = 0;
    while (Date.now() - t0 < maxMs) {
      await sleep(2000);
      // 测验 iframe 里的脚本提交后会 postMessage 过来；顶层看不到跨域内容时以这个为准
      if (quizWasSubmitted()) return true;

      // “确认提交？”是页面自绘弹窗，不是原生 confirm，必须再点一次提交
      const dialog = findConfirmDialog(findQuizDoc() || document);
      if (dialog && clickConfirmDialog(dialog)) {
        log('已确认提交弹窗', 'ok');
        await sleep(2500);
        continue;
      }

      const doc = findQuizDoc();
      if (!doc) continue;
      const body = (doc.body && doc.body.innerText) || '';
      if (/我的答案|正确答案|本次成绩|查看答案|已提交/.test(body)) return true;

      const qs = Array.from(doc.querySelectorAll('.TiMu'));
      if (!qs.length) {
        if (sawQuiz) return true;
        continue;
      }
      sawQuiz = true;
      const filled = qs.filter((q) => q.querySelector('.check_answer, .check_answer_dx, input:checked, textarea')).length;
      const maySubmit = isExamPage() ? CFG.autoSubmitExam : CFG.autoSubmitWork;
      if (maySubmit && qs.length && filled >= qs.length && Date.now() - lastSubmit > 15000) {
        lastSubmit = Date.now();
        broadcastCmd('submit');
        await sleep(2000);
        const dlg = findConfirmDialog(doc);
        if (dlg && clickConfirmDialog(dlg)) log('已确认提交弹窗', 'ok');
      }
    }
    return false;
  }

  async function handleQuizTab() {
    if (!CFG.autoQuizTab) return false;
    const tab = document.querySelector('#dct2');
    if (!tab || tab.offsetParent === null) return false;
    const keys = quizKeys();
    if (!keys.length || keys.every((id) => quizVisited.has(id))) return false;
    keys.forEach((id) => { quizVisited.add(id); quizTriedAt[id] = Date.now(); });
    if (quizTabBusy) return false;
    quizTabBusy = true;
    const beforeUrl = location.href;
    try {
      log('发现待完成章节测验，正在进入答题…', 'info');
      tab.click();
      await sleep(4500);
      const ok = await waitQuizDone(120000);
      if (ok) keys.forEach((id) => quizSubmitted.add(id));
      log(ok ? '章节测验已完成，返回知识学习' : '章节测验等待超时，先返回知识学习', ok ? 'ok' : 'warn');
      const back = document.querySelector('#dct1');
      if (back) {
        back.click();
        await sleep(4000);
      } else if (!/studentstudy|knowledge\/cards/.test(location.href)) {
        // 测验在独立页面打开：先尝试返回，再不行直接回原章节地址
        try { history.back(); await sleep(3000); } catch (e) { /* ignore */ }
        if (!/studentstudy|knowledge\/cards/.test(location.href)) location.href = beforeUrl;
        await sleep(2000);
      }
      return ok;
    } finally {
      quizTabBusy = false;
    }
  }

  function deepVideoState(win, depth, ancestorVisible) {
    let total = 0;
    let done = 0;
    let pending = 0;
    const d = depth || 0;
    const containerVisible = ancestorVisible !== false;
    try {
      const vs = win.document.querySelectorAll('video');
      for (let i = 0; i < vs.length; i++) {
        try {
          const v = vs[i];
          const dur = Number(v.duration);
          const cur = Number(v.currentTime) || 0;
          const started = cur > 0.1 || Number(v.__lcsLastTime) > 0.1 || !!v.__lcsEndedAt;
          const vr = v.getBoundingClientRect();
          const shown = containerVisible && vr.width > 0 && vr.height > 0;
          if (!shown && !started && !v.__lcsGateBlocked) continue;
          total++;
          if (v.ended || (Number.isFinite(dur) && dur > 0 && cur >= dur - 1.5)) {
            done++;
          } else if (v.__lcsGateBlocked) {
            // 被任务点门控挡下的普通视频不算“等待中”。
            done++;
          } else if ((!Number.isFinite(dur) || dur <= 0) && v.readyState === 0) {
            // 切章后残留、尚未加载的播放器不能永久阻塞跳章。
            done++;
          } else {
            pending++;
          }
        } catch (e) { /* ignore */ }
      }
      if (d < 4) {
        const fs = win.document.querySelectorAll('iframe');
        for (let i = 0; i < fs.length; i++) {
          try {
            if (fs[i].contentWindow) {
              const fr = fs[i].getBoundingClientRect();
              const frameShown = containerVisible && fr.width > 0 && fr.height > 0;
              const sub = deepVideoState(fs[i].contentWindow, d + 1, frameShown);
              total += sub.total;
              done += sub.done;
              pending += sub.pending;
            }
          } catch (e) { /* cross-origin */ }
        }
      }
    } catch (e) { /* ignore */ }
    return { total, done, pending };
  }

  function nextChapterIdFromState() {
    const el = document.querySelector('#_studystate');
    if (!el) return '';
    const m = String(el.value || '').match(/nextChapterId\s*:\s*(\d+)/);
    return m ? m[1] : '';
  }

  // 新版页面没有 nextChapterId / 下一节按钮时，按右侧目录顺序进入下一节
  function nextChapterFromCatalog() {
    const cid = currentChapterId();
    if (!cid) return false;
    const nodes = Array.from(document.querySelectorAll('.posCatalog_select[id^="cur"], .chapter_item[id^="cur"]'));
    if (!nodes.length) return false;
    const idx = nodes.findIndex((n) => String(n.id || '').replace(/^cur/, '') === cid);
    if (idx < 0 || idx >= nodes.length - 1) return false;
    const next = nodes[idx + 1];
    const target = next.querySelector('.posCatalog_name, .catalog_name, .clicktitle') || next;
    try {
      target.click();
      log('按目录顺序进入下一节', 'info');
      return true;
    } catch (e) { return false; }
  }

  function navigateToChapter(cid) {
    try {
      const u = new URL(location.href);
      ['workId', 'workid', 'workRelationId', 'jobid'].forEach((k) => u.searchParams.delete(k));
      u.searchParams.set('chapterId', cid);
      location.href = u.toString();
      return true;
    } catch (e) { return false; }
  }

  function findNextButton() {
    const docs = sameOriginDocs(window, 0);
    for (const doc of docs) {
      const known = [
        doc.querySelector('#prevNextFocusNext'),
        doc.querySelector('.jb_btn.nextChapter'),
        doc.querySelector('a.nextChapter'),
      ].find((b) => b && b.offsetParent !== null && b.style.display !== 'none');
      if (known) return known;
    }
    // 新版页面底部是自绘按钮，只能按文字找；取最内层元素，点击会冒泡到按钮
    for (const doc of docs) {
      const cands = Array.from(doc.querySelectorAll('button, a, div, span'))
        .filter((el) => visible(el) && /^下一节/.test(textOf(el).replace(/\s+/g, '')))
        .sort((a, b) => (a.childElementCount || 0) - (b.childElementCount || 0));
      if (cands[0]) return cands[0];
    }
    return null;
  }

  async function nextChapterClick() {
    const btn = findNextButton();

    lastNextClick = Date.now();
    if (btn) {
      const before = location.href;
      log('本节可做的事已处理完，跳转下一节', 'ok');
      btn.click();
      await sleep(4000);
      if (location.href === before) {
        const nid = nextChapterIdFromState();
        if (nid && nid !== currentChapterId()) {
          log('按钮未生效，按 nextChapterId 直接跳转', 'warn');
          navigateToChapter(nid);
        } else if (nextChapterFromCatalog()) {
          await sleep(4000);
        } else {
          log('未找到下一章节，可能已是最后一节', 'warn');
        }
      }
    } else {
      const nid = nextChapterIdFromState();
      if (nid && nid !== currentChapterId()) {
        log('未找到下一节按钮，按 nextChapterId 直接跳转', 'warn');
        navigateToChapter(nid);
      } else if (nextChapterFromCatalog()) {
        await sleep(4000);
      } else {
        log('已是最后一节，无法继续跳转', 'warn');
      }
    }
  }

  async function goNextChapter() {
    if (!CFG.autoNext) return;
    if (!IS_TOP) return;
    if (quizTabBusy) return;
    if (Date.now() - lastNextClick < 10000) return;
    if (!isChapterPage()) return;

    const cid = currentChapterId();
    if (cid !== lastCid) {
      lastCid = cid;
      doneStreak = 0;
      videoZeroSince = 0;
      videoDoneSince = 0;
      emptySince = 0;
      videoSkipped = false;
      videoClicked = false;
      unknownSkipped = false;
    }

    // 已经出现“我的答案/正确答案”的结果页：视为测验已完成
    const resultDoc = quizResultDoc();
    if (resultDoc) quizKeys().forEach((id) => quizSubmitted.add(id));

    // 章节测验标签页由答题流程负责，这里不要跳章
    const quizTabHere = quizTabExists();
    if (activeTab() === 2) {
      if (resultDoc) {
        if (findNextButton()) {
          await nextChapterClick();
          return;
        }
        const back = document.querySelector('#dct1');
        if (back) { back.click(); await sleep(3000); }
        return;
      }
      // 测验已提交/已跳过：自动切回知识学习，让下一节流程继续
      if (quizWasSubmitted()) {
        const back = document.querySelector('#dct1');
        if (back) { back.click(); await sleep(3000); }
      }
      return;
    }
    // 结果页优先直接点页面下方的“下一节”，不等任务点
    if (resultDoc) {
      if (findNextButton()) { await nextChapterClick(); return; }
      const back = document.querySelector('#dct1');
      if (back) { back.click(); await sleep(3000); return; }
      if (cid) { navigateToChapter(cid); return; }
    }
    // 手动提交（没走自动进测验标签）时，也把结果页切回知识学习
    if (quizWasSubmitted() && findQuizDoc()) {
      const back = document.querySelector('#dct1');
      if (back) { back.click(); await sleep(3000); return; }
      if (cid) { navigateToChapter(cid); return; }
    }
    if (quizFrameEl()) return;
    if (findQuizDoc() && !quizWasSubmitted()) {
      const tryKey = quizKeys()[0] || cid;
      if (!quizTriedAt[tryKey]) quizTriedAt[tryKey] = Date.now();
      if (Date.now() - quizTriedAt[tryKey] < 180000) return;
      quizKeys().forEach((id) => quizSubmitted.add(id));
      log('本页题目 3 分钟未完成，跳过本节', 'warn');
    }

    const info = jobInfo();
    if (!info.ready) { doneStreak = 0; return; }
    if (infoLoggedCid !== cid) {
      infoLoggedCid = cid;
      log(`本章任务点：视频 ${info.videoUnfinished} 个待完成 / 测验 ${info.quizUnfinished} 个待完成 / 文档 ${info.docUnfinished} 个`, 'info');
    }

    const vs = deepVideoState(window, 0);
    const videoEndedLocally = vs.total > 0 && vs.done === vs.total;

    // 1) 有未完成视频任务点：等它真正播完；播完后短暂等待平台打勾
    if (info.videoUnfinished > 0 && !videoSkipped) {
      doneStreak = 0;
      if (vs.total === 0) {
        if (!videoZeroSince) videoZeroSince = Date.now();
        if (!videoClicked && Date.now() - videoZeroSince > 10000) {
          videoClicked = true;
          const job = info.unfinished.find(isVideoJob);
          if (job) {
            try { job.click(); log('尝试打开未完成的视频任务点…', 'info'); } catch (e) { /* ignore */ }
          }
        }
        if (Date.now() - videoZeroSince < 25000) { log('等待视频任务点加载…', 'info'); return; }
        videoSkipped = true;
        log('视频任务点 25 秒未出现播放器，跳过本节', 'warn');
      } else if (vs.done < vs.total) {
        videoZeroSince = 0;
        videoDoneSince = 0;
        return;
      } else {
        if (!videoDoneSince) videoDoneSince = Date.now();
        if (Date.now() - videoDoneSince < 5000) { log('视频已播完，等待平台标记任务点…', 'info'); return; }
        videoSkipped = true;
        log('视频已播完但任务点未打勾，按已完成继续', 'warn');
      }
    } else {
      videoZeroSince = 0;
      videoDoneSince = 0;
    }

    const quizDone = quizWasSubmitted();
    const pendingVideo = info.videoUnfinished > 0 && !videoSkipped;
    const pendingQuiz = (info.quizUnfinished > 0 || quizTabPending()) && !quizDone;
    const pendingUnknown = info.unfinished.some((n) => !isVideoJob(n) && !isQuizJob(n)) && !unknownSkipped;

    // 2) 待完成章节测验：切到测验标签页作答（视频任务优先，等视频处理完再进）
    if (!pendingVideo && (pendingQuiz || pendingUnknown)) {
      if (CFG.autoQuizTab && quizTabExists() && !quizWasVisited()) {
        await handleQuizTab();
        return;
      }
      if (!quizDone) {
        const tryKey = quizKeys()[0] || cid;
        if (!quizTriedAt[tryKey]) quizTriedAt[tryKey] = Date.now();
        if (Date.now() - quizTriedAt[tryKey] < 120000) return;
        quizKeys().forEach((id) => quizSubmitted.add(id));
        unknownSkipped = true;
        log('章节测验 2 分钟未完成，跳过本节', 'warn');
      }
    }

    // 视频任务处理完、但仍有一个没进过的“章节测验”标签：先进入测验，绝不能当成空章节点下一节
    if (quizTabHere && !quizWasVisited() && !pendingVideo) {
      if (CFG.autoQuizTab) {
        await handleQuizTab();
        return;
      }
      log('本章有章节测验，已暂停自动跳章，请先处理测验', 'warn');
      return;
    }

    // 3) 剩余任务点：视频已处理；测验已提交/跳过；文档类无法代做
    const remaining = info.unfinished.filter((n) => {
      if (quizDone && isQuizJob(n)) return false;
      if (videoSkipped && isVideoJob(n)) return false;
      if (unknownSkipped && !isVideoJob(n) && !isQuizJob(n)) return false;
      return true;
    });
    if (remaining.length > 0) { doneStreak = 0; return; }

    if (!emptySince) emptySince = Date.now();
    doneStreak++;
    // 测验已提交后不用再等 15 秒试探，确认两次即可进入下一节
    if (quizDone) {
      if (doneStreak < 1 || Date.now() - emptySince < 2500) return;
    } else if (videoEndedLocally) {
      // 已经明确看到视频结尾，不再做长时间的“空页面”试探。
      if (doneStreak < 1 || Date.now() - emptySince < 2500) return;
    } else if (doneStreak < 2 || Date.now() - emptySince < 15000) return;
    doneStreak = 0;
    emptySince = 0;

    await nextChapterClick();
  }

  /* ======================================================================
   * 12. 答题主流程
   * ==================================================================== */
  function isSubmittedView() {
    if (/\/work\/view|workDetail|examDetail|selectWorkQuestionYiPiYue|selectWorkQuestionYiPiYue/.test(location.href)) return true;
    const marks = $$('.mark_answer, .rightAnswerContent').filter(visible);
    if (marks.length) return true;
    const body = (document.body && document.body.innerText) || '';
    if (/我的答案|正确答案|本次成绩|查看答案/.test(body)) return true;
    return false;
  }

  let answeredKey = '';
  const submittedNotified = new Set();

  async function runAnswerFlow(force) {
    if (state.answering) return;
    if (isSubmittedView()) {
      const k = location.href;
      if (!submittedNotified.has(k)) {
        submittedNotified.add(k);
        log('这是已提交的作业详情页，跳过自动作答', 'info');
      }
      return;
    }
    const key = location.href + '#' + document.querySelectorAll('.TiMu,.questionLi,[qid]').length;
    if (!force && answeredKey === key) return;

    state.answering = true;
    try {
      await decryptDocument(document);
      // 解密会改变 DOM 文本，重新解析
      let qs = collectQuestions(document);
      qs = qs.filter((q) => q.options.length > 0 || q.type === 'blank' || q.type === 'short');
      if (decryptFailed) qs.forEach((q) => { q.encrypted = true; });
      if (!qs.length) { state.answering = false; return; }
      state.questions = qs;
      renderQuestions();
      await answerAll(qs, { force: !!force });
      const unanswered = qs.filter((q) => !qHasAnswerInDom(q));
      if (unanswered.length) {
        answeredKey = '';
        log('仍有 ' + unanswered.length + ' 题未填入，已停止自动提交并等待重试', 'warn');
        return;
      }
      answeredKey = key;

      const needSubmit = isExamPage() ? CFG.autoSubmitExam : CFG.autoSubmitWork;
      if (needSubmit) {
        await sleep(1200);
        if (submitWork()) {
          log('已触发提交', 'ok');
          await confirmSubmitDialog();
          setTimeout(() => {
            try { window.top.postMessage({ __lcsQuizDone: 1 }, '*'); } catch (e) { /* ignore */ }
          }, 2500);
        } else {
          log('未找到提交按钮，请手动提交', 'warn');
        }
      } else {
        log('已关闭自动提交，答案已填入，请自行检查后提交', 'info');
      }
    } catch (e) {
      log('答题流程异常：' + e.message, 'error');
    } finally {
      state.answering = false;
    }
  }

  function broadcastCmd(cmd) {
    const msg = { __lcsCmd: cmd };
    try {
      Array.from(document.querySelectorAll('iframe')).forEach((f) => {
        try { if (f.contentWindow) f.contentWindow.postMessage(msg, '*'); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  /* ======================================================================
   * 13. UI
   * ==================================================================== */
  const UI = { root: null, host: null, tab: 'status' };
  const DONATION_QR = 'data:image/png;base64,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';

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap { position: fixed; right: 18px; bottom: 96px; z-index: 2147483000;
  font-family: -apple-system, "Segoe UI", system-ui, "Microsoft YaHei", sans-serif; }
.fab { width: 52px; height: 52px; border-radius: 16px; cursor: grab; user-select: none; touch-action: none;
  background: linear-gradient(145deg, #14b8a6, #0891b2); color: #fff; font-size: 20px;
  display: flex; align-items: center; justify-content: center; font-weight: 700;
  box-shadow: 0 10px 26px rgba(8,145,178,.35); transition: transform .18s ease; }
.fab:hover { transform: translateY(-2px) scale(1.03); }
.panel { position: absolute; right: 0; bottom: 64px; width: 336px; max-height: 74vh;
  background: #0e1621; color: #dbe6f0; border: 1px solid rgba(255,255,255,.09);
  border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.5); overflow: hidden;
  display: flex; flex-direction: column; font-size: 13px; }
.panel.hidden { display: none; }
.head { display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  background: linear-gradient(120deg, #0f766e, #0e7490); cursor: move; user-select: none; touch-action: none; }
.head .title { font-weight: 600; font-size: 13px; flex: 1; letter-spacing: .2px; }
.head .ver { font-size: 10px; opacity: .75; padding: 1px 6px; border-radius: 20px;
  background: rgba(255,255,255,.14); }
.head button { background: none; border: 0; color: #e6f6f5; font-size: 18px; cursor: pointer;
  line-height: 1; padding: 0 2px; opacity: .8; }
.head button:hover { opacity: 1; }
.tabs { display: flex; gap: 4px; padding: 8px 12px 0; background: #0b131c; }
.tabs button { flex: 1; padding: 7px 0; border: 0; background: transparent; color: #7f95a8;
  font-size: 12px; cursor: pointer; border-radius: 8px 8px 0 0; }
.tabs button.on { color: #5eead4; background: rgba(94,234,212,.08); font-weight: 600; }
.body { padding: 12px; overflow: auto; }
.body::-webkit-scrollbar { width: 6px; }
.body::-webkit-scrollbar-thumb { background: rgba(255,255,255,.14); border-radius: 3px; }
.sec { display: none; }
.sec.on { display: block; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 6px 0; border-bottom: 1px dashed rgba(255,255,255,.06); }
.row:last-child { border-bottom: 0; }
.row .k { color: #9fb2c4; font-size: 12px; }
.row .v { color: #e8f6f4; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.btn { width: 100%; padding: 9px; margin-top: 8px; border: 1px solid rgba(94,234,212,.35);
  background: rgba(94,234,212,.1); color: #5eead4; border-radius: 10px; cursor: pointer;
  font-size: 12px; font-weight: 600; transition: background .15s; }
.btn:hover { background: rgba(94,234,212,.2); }
.btn.ghost { border-color: rgba(255,255,255,.12); background: rgba(255,255,255,.04); color: #c6d4e0; }
.btn.danger { border-color: rgba(248,113,113,.35); background: rgba(248,113,113,.1); color: #fca5a5; }
.field { margin-bottom: 10px; }
.field label { display: block; font-size: 11px; color: #8fa4b8; margin-bottom: 4px; }
.field input[type=text], .field input[type=password], .field select {
  width: 100%; padding: 7px 9px; border-radius: 8px; border: 1px solid rgba(255,255,255,.1);
  background: #0a1017; color: #dbe6f0; font-size: 12px; outline: none; }
.field input:focus, .field select:focus { border-color: rgba(94,234,212,.5); }
.field input[type=range] { width: 100%; accent-color: #2dd4bf; }
.switch { position: relative; width: 38px; height: 21px; flex: 0 0 auto; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch span { position: absolute; inset: 0; background: #24313f; border-radius: 20px;
  cursor: pointer; transition: .18s; }
.switch span:before { content: ""; position: absolute; width: 15px; height: 15px; left: 3px; top: 3px;
  background: #8ba0b4; border-radius: 50%; transition: .18s; }
.switch input:checked + span { background: rgba(45,212,191,.35); }
.switch input:checked + span:before { transform: translateX(17px); background: #2dd4bf; }
.logbox { height: 210px; overflow: auto; font-size: 11px; line-height: 1.7;
  background: #080d13; border-radius: 8px; padding: 8px; border: 1px solid rgba(255,255,255,.06); }
.logbox div { word-break: break-all; }
.logbox .t { color: #56697a; margin-right: 6px; }
.logbox .info { color: #a9bccd; }
.logbox .ok { color: #4ade80; }
.logbox .warn { color: #fbbf24; }
.logbox .error { color: #f87171; }
.donate-card { padding: 10px; text-align: center;
  background: #080d13; border: 1px solid rgba(255,255,255,.06); border-radius: 10px; }
.donate-card img { display: block; width: 100%; max-width: 260px; margin: 0 auto;
  border-radius: 10px; background: #fff; }
.donate-hint { margin-top: 7px; color: #8fa4b8; font-size: 11px; line-height: 1.6; }
.qlist { display: grid; gap: 6px; }
.qitem { padding: 7px 9px; border-radius: 8px; background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.05); font-size: 11px; line-height: 1.6; }
.qitem .qs { color: #a9bccd; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.qitem .qa { color: #5eead4; margin-top: 3px; }
.tip { font-size: 11px; color: #6f8398; line-height: 1.7; margin-top: 8px; }
.badge { display: inline-block; padding: 0 6px; border-radius: 20px; font-size: 10px;
  background: rgba(94,234,212,.14); color: #5eead4; margin-left: 6px; }
`;

  function fmtTime(ts) {
    const d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }

  function buildUI() {
    if (!IS_TOP || UI.host) return;
    // 油猴更新脚本但页面未刷新时，旧脚本创建的宿主可能仍留在这里。
    $$('#lcs-cx-host').forEach((oldHost) => oldHost.remove());
    const host = document.createElement('div');
    host.id = 'lcs-cx-host';
    (document.body || document.documentElement).appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    UI.host = host;
    UI.root = root;

    root.innerHTML = `
<style>${CSS}</style>
<div class="wrap">
  <div class="panel" id="panel">
    <div class="head" id="head">
      <span class="title">学习通 AI 助手</span>
      <span class="ver">v${VERSION}</span>
      <button id="btn-min" title="收起">–</button>
    </div>
    <div class="tabs">
      <button data-tab="status" class="on">运行</button>
      <button data-tab="cfg">设置</button>
      <button data-tab="log">日志</button>
      <button data-tab="donate">捐赠</button>
    </div>
    <div class="body">
      <div class="sec on" id="sec-status">
        <div class="row"><span class="k">页面</span><span class="v" id="st-page">-</span></div>
        <div class="row"><span class="k">视频 / 倍速</span><span class="v" id="st-video">0 / 2.0x</span></div>
        <div class="row"><span class="k">任务点</span><span class="v" id="st-job">-</span></div>
        <div class="row"><span class="k">AI 调用 / 缓存命中</span><span class="v" id="st-ai">0 / 0</span></div>
        <button class="btn" id="btn-scan">重新扫描视频</button>
        <button class="btn" id="btn-answer">AI 回答本页题目</button>
        <button class="btn ghost" id="btn-submit">手动提交</button>
        <button class="btn ghost" id="btn-next">下一节</button>
        <div class="tip" id="q-head" style="display:none">本页题目</div>
        <div class="qlist" id="qlist"></div>
      </div>
      <div class="sec" id="sec-cfg"></div>
      <div class="sec" id="sec-log">
        <div class="logbox" id="logbox"></div>
      </div>
      <div class="sec" id="sec-donate">
        <div class="donate-card">
          <img id="donate-qr" alt="微信捐赠二维码">
          <div class="donate-hint">如果这个脚本帮到了你，可以扫码支持作者</div>
        </div>
      </div>
    </div>
  </div>
  <div class="fab" id="fab">AI</div>
</div>`;

    const panel = root.getElementById('panel');
    const fab = root.getElementById('fab');
    let fabDragged = false;
    root.getElementById('btn-min').addEventListener('click', () => panel.classList.add('hidden'));
    fab.addEventListener('click', (e) => {
      if (fabDragged) {
        fabDragged = false;
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      panel.classList.toggle('hidden');
    });

    root.querySelectorAll('.tabs button').forEach((b) => {
      b.addEventListener('click', () => {
        UI.tab = b.dataset.tab;
        root.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
        root.querySelectorAll('.sec').forEach((s) => s.classList.toggle('on', s.id === 'sec-' + UI.tab));
      });
    });

    root.getElementById('btn-scan').addEventListener('click', () => { scanVideos(); broadcastCmd('scan'); log('已重新扫描视频', 'info'); });
    root.getElementById('btn-answer').addEventListener('click', () => { runAnswerFlow(true); broadcastCmd('answer'); });
    root.getElementById('btn-next').addEventListener('click', () => { void nextChapterClick(); });
    root.getElementById('btn-submit').addEventListener('click', () => {
      if (submitWork()) {
        log('已触发提交', 'ok');
        void confirmSubmitDialog();
      } else {
        log('未找到提交按钮', 'warn');
      }
      broadcastCmd('submit');
    });
    const donateImg = root.getElementById('donate-qr');
    if (donateImg) donateImg.src = DONATION_QR;

    // 拖拽：标题栏和右下角 AI 方块都能拖，整个悬浮组件一起移动
    (function drag() {
      const head = root.getElementById('head');
      const wrap = root.querySelector('.wrap');
      let sx = 0, sy = 0, ox = 0, oy = 0, moving = false, moved = false;
      const start = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        const r = wrap.getBoundingClientRect();
        wrap.style.right = 'auto'; wrap.style.bottom = 'auto';
        wrap.style.left = r.left + 'px'; wrap.style.top = r.top + 'px';
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        moving = true;
        moved = false;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      };
      const move = (e) => {
        if (!moving) return;
        const dx = e.clientX - sx;
        const dy = e.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 6) {
          moved = true;
          if (e.currentTarget === fab) fabDragged = true;
        }
        wrap.style.left = clamp(ox + dx, 4, innerWidth - 80) + 'px';
        wrap.style.top = clamp(oy + dy, 4, innerHeight - 60) + 'px';
      };
      const end = (e) => {
        moving = false;
        if (e && e.currentTarget === fab && !moved) fabDragged = false;
      };
      [head, fab].forEach((el) => {
        el.addEventListener('pointerdown', start);
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
      });
    })();

    buildSettings(root);

    logSinks.push((entry) => appendLogLine(root, entry));
    state.logs.forEach((entry) => appendLogLine(root, entry));
  }

  function appendLogLine(root, entry) {
    const box = root.getElementById('logbox');
    if (!box) return;
    const div = document.createElement('div');
    div.className = entry.type || 'info';
    div.innerHTML = '<span class="t">' + fmtTime(entry.t) + '</span>' + esc(entry.msg);
    box.appendChild(div);
    while (box.childNodes.length > LOG_MAX) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  const SCHEMA = [
    { k: 'apiKey', label: 'DeepSeek API Key', type: 'password', ph: 'sk-xxxxxxxx' },
    { k: 'baseUrl', label: '接口地址', type: 'text', ph: 'https://api.deepseek.com/v1' },
    { k: 'model', label: '模型', type: 'select', options: ['deepseek-chat', 'deepseek-reasoner'] },
    { k: 'rate', label: '视频倍速（最高 2.0，避免任务点卡住）', type: 'range', min: 1, max: 2, step: 0.25 },
    { k: 'autoPlay', label: '自动播放视频', type: 'switch' },
    { k: 'mute', label: '静音播放', type: 'switch' },
    { k: 'resumeOnPause', label: '暂停后自动续播', type: 'switch' },
    { k: 'stallRecovery', label: '播放停滞自动恢复', type: 'switch' },
    { k: 'quizAI', label: 'AI 处理视频弹题', type: 'switch' },
    { k: 'autoNext', label: '任务点完成后自动下一节', type: 'switch' },
    { k: 'autoQuizTab', label: '自动进入章节测验并作答', type: 'switch' },
    { k: 'autoAnswer', label: '页面加载后自动答题', type: 'switch' },
    { k: 'autoSubmitWork', label: '作业/章节测验自动提交', type: 'switch' },
    { k: 'autoSubmitExam', label: '考试自动提交（慎用）', type: 'switch' },
    { k: 'answerShort', label: '简答题也交给 AI（更长等待）', type: 'switch' },
    { k: 'skipAnswered', label: '跳过已作答的题', type: 'switch' },
    { k: 'decryptFont', label: '尝试解密切题干字体', type: 'switch' },
    { k: 'batchSize', label: '每次请求题目数', type: 'number', min: 1, max: 8 },
  ];

  function buildSettings(root) {
    const box = root.getElementById('sec-cfg');
    box.innerHTML = SCHEMA.map((f) => {
      if (f.type === 'switch') {
        return `<div class="row"><span class="k">${esc(f.label)}</span>
          <label class="switch"><input type="checkbox" data-k="${f.k}" ${CFG[f.k] ? 'checked' : ''}><span></span></label></div>`;
      }
      if (f.type === 'select') {
        return `<div class="field"><label>${esc(f.label)}</label>
          <select data-k="${f.k}">${f.options.map((o) => `<option value="${o}" ${CFG[f.k] === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
      }
      if (f.type === 'range') {
        return `<div class="field"><label>${esc(f.label)} <b id="rate-val" style="color:#5eead4">${CFG[f.k]}</b></label>
          <input type="range" data-k="${f.k}" min="${f.min}" max="${f.max}" step="${f.step}" value="${CFG[f.k]}"></div>`;
      }
      if (f.type === 'number') {
        return `<div class="field"><label>${esc(f.label)}</label>
          <input type="number" data-k="${f.k}" min="${f.min}" max="${f.max}" value="${CFG[f.k]}"></div>`;
      }
      return `<div class="field"><label>${esc(f.label)}</label>
        <input type="${f.type}" data-k="${f.k}" value="${esc(CFG[f.k])}" placeholder="${esc(f.ph || '')}"></div>`;
    }).join('') + `<button class="btn" id="btn-test" style="margin-top:10px">测试 API 连接</button>
      <div class="tip">API Key 只保存在本机油猴存储中，不会上传到任何第三方。填写后自动保存，点上面按钮可验证连通性。</div>`;

    const tester = box.querySelector('#btn-test');
    if (tester) {
      tester.addEventListener('click', async () => {
        if (!CFG.apiKey) { log('请先填写 API Key', 'warn'); return; }
        tester.textContent = '测试中…';
        try {
          const r = await callDeepSeek([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 16, temperature: 0 });
          log('API 连接正常：' + String(r).replace(/\s+/g, ' ').slice(0, 40), 'ok');
          tester.textContent = '连接正常';
        } catch (e) {
          log('API 连接失败：' + e.message, 'error');
          tester.textContent = '连接失败（见日志）';
        }
        setTimeout(() => { tester.textContent = '测试 API 连接'; }, 3500);
      });
    }

    const handler = (e) => {
      const el = e.target.closest('[data-k]');
      if (!el) return;
      const k = el.dataset.k;
      let v;
      if (el.type === 'checkbox') v = el.checked;
      else if (el.type === 'range' || el.type === 'number') v = Number(el.value);
      else v = el.value;
      CFG[k] = v;
      saveCfg();
      if (k === 'rate') {
        const lab = root.getElementById('rate-val');
        if (lab) lab.textContent = v;
        VIDEOS.forEach(enforceRate);
      }
      updateStatus();
    };
    box.addEventListener('input', handler);
    box.addEventListener('change', handler);
  }

  function renderQuestions() {
    if (!UI.root) return;
    const list = UI.root.getElementById('qlist');
    const head = UI.root.getElementById('q-head');
    if (!list) return;
    const qs = state.questions;
    head.style.display = qs.length ? 'block' : 'none';
    head.textContent = '本页题目（' + qs.length + '）';
    list.innerHTML = qs.map((q) => {
      const ans = q.answer && q.answer.length ? q.answer.join(' / ') : (q.ok ? '已作答' : '待作答');
      return `<div class="qitem">
        <div class="qs">${esc((q.stem || '(无题干)').slice(0, 90))}<span class="badge">${TYPE_LABEL[q.type] || q.type}</span></div>
        <div class="qa">${esc(String(ans).slice(0, 120))}</div>
      </div>`;
    }).join('');
  }

  function updateStatus() {
    if (!UI.root) return;
    const set = (id, v) => { const el = UI.root.getElementById(id); if (el) el.textContent = v; };
    let page = '其他';
    if (isChapterPage()) page = '章节学习';
    else if (isExamPage()) page = '考试';
    else if (document.querySelector('.questionLi')) page = '作业';
    else if (document.querySelector('.TiMu')) page = '章节测验';
    set('st-page', page);
    set('st-video', countVideosDeep(window, 4) + ' / ' + (Number(CFG.rate) || 1).toFixed(2) + 'x');
    let jobTxt = '-';
    const f = chapterFrame();
    if (f) {
      const doc = getDocSafe(f);
      if (doc) {
        const all = jobNodes(doc);
        const jobs = all.filter((n) => !DOC_JOB_RE.test(String(n.className || '')));
        if (jobs.length) {
          const done = jobs.filter((j) => j.classList.contains('ans-job-finished') ||
            (j.closest && j.closest('.ans-job-finished'))).length;
          jobTxt = done + ' / ' + jobs.length + (all.length > jobs.length ? '（跳过文档 ' + (all.length - jobs.length) + '）' : '');
        }
      }
    }
    set('st-job', jobTxt);
    try {
      const allowVideo = jobInfo().videoUnfinished > 0;
      window.__lcsAllowTaskVideo = allowVideo;
      Array.from(document.querySelectorAll('iframe')).forEach((f) => {
        try { if (f.contentWindow) f.contentWindow.postMessage({ __lcsAllowVideo: allowVideo }, '*'); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
    set('st-ai', state.stats.asked + ' / ' + state.stats.cacheHit);
  }

  /* ======================================================================
   * 14. 启动
   * ==================================================================== */
  function isTargetPage() {
    if (!/chaoxing\.com$/.test(location.hostname) &&
        !/\.edu\.cn$/.test(location.hostname) &&
        !/nbdlib\.cn$/.test(location.hostname) &&
        !/hnsyu\.net$/.test(location.hostname) &&
        !/gdhkmooc\.com$/.test(location.hostname)) return false;
    return true;
  }

  function boot() {
    if (!isTargetPage()) return;

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d) return;
      if (typeof d.__lcsAllowVideo === 'boolean') {
        window.__lcsAllowTaskVideo = d.__lcsAllowVideo;
        try {
          Array.from(document.querySelectorAll('iframe')).forEach((f) => {
            try { if (f.contentWindow) f.contentWindow.postMessage(d, '*'); } catch (e) { /* ignore */ }
          });
        } catch (e) { /* ignore */ }
        return;
      }
      if (d.__lcsQuizDone) {
        quizKeys().forEach((id) => quizSubmitted.add(id));
        log('收到章节测验完成信号', 'ok');
        return;
      }
      if (!d.__lcsCmd) return;
      if (d.cmd === 'answer') runAnswerFlow(true);
      else if (d.cmd === 'submit') {
        if (submitWork()) void confirmSubmitDialog();
      } else if (d.cmd === 'scan') scanVideos();
      try {
        Array.from(document.querySelectorAll('iframe')).forEach((f) => {
          try { if (f.contentWindow) f.contentWindow.postMessage(d, '*'); } catch (err) { /* ignore */ }
        });
      } catch (err) { /* ignore */ }
    });

    if (IS_TOP) {
      buildUI();
      window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || d.__lcsLog !== 1 || !d.entry) return;
        const host = String(e.origin || '').replace(/^https?:\/\//, '');
        if (!/(^|\.)chaoxing\.com$/.test(host) && !/\.edu\.cn$/.test(host) && !/\.(nbdlib\.cn|hnsyu\.net|gdhkmooc\.com)$/.test(host)) return;
        state.logs.push(d.entry);
        if (state.logs.length > LOG_MAX) state.logs.shift();
        logSinks.forEach((fn) => { try { fn(d.entry); } catch (err) { /* ignore */ } });
      });
      try {
        if (typeof GM_registerMenuCommand === 'function') {
          GM_registerMenuCommand('打开学习通 AI 助手', () => {
            const p = UI.root && UI.root.getElementById('panel');
            if (p) p.classList.remove('hidden');
          });
        }
      } catch (e) { /* ignore */ }
    }

    scanVideos();
    startStallRecovery();
    setInterval(scanVideos, 1500);
    setInterval(checkQuiz, 1000);

    if (IS_TOP) {
      setInterval(goNextChapter, 3000);
      setInterval(() => {
        reloadCfg();
        updateStatus();
      }, 1500);
    } else {
      setInterval(reloadCfg, 2000);
    }

    const tryAnswer = () => {
      if (!CFG.autoAnswer) return;
      const n = document.querySelectorAll('.TiMu, .questionLi, [qid]').length;
      if (n > 0) runAnswerFlow(false);
    };
    setTimeout(tryAnswer, 2200);
    setInterval(() => {
      if (!CFG.autoAnswer) return;
      if (state.answering) return;
      const n = document.querySelectorAll('.TiMu, .questionLi, [qid]').length;
      if (n > 0) tryAnswer();
    }, 4000);

    if (IS_TOP) log('脚本已启动 v' + VERSION, 'ok');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
