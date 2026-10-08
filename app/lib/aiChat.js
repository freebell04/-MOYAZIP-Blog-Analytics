// AI 채팅(ChatGPT / Gemini / Claude)과 앱을 연결한다.
//
// 버튼을 누르면 로그인용 디버그 크롬에 그 AI 채팅을 새 탭으로 열고, 글감·말투·형식이 담긴 요청문을
// 입력창에 넣어 보낸다. 이후 대화(방향 고르기, 수정)는 사용자가 그 탭에서 직접 하고,
// 사용자가 "완성"이라고 해서 AI가 최종 JSON을 코드블록으로 내놓으면 그걸 자동으로 알아채 앱으로 가져온다.
// (앱은 그 결과로 네이버 글쓰기 창을 열어 채운다)
//
// 각 AI 사이트에는 사용자가 이 크롬에서 한 번 직접 로그인해야 한다. 로그인이 안 돼 있으면 탭을 열어둔 채
// 로그인할 때까지 기다렸다가, 입력창이 생기면 그때 요청문을 넣는다.
const session = require("./session");
const { connectPage } = require("./like");

const SITES = {
  chatgpt: {
    name: "ChatGPT",
    url: "https://chatgpt.com/",
    input: ['#prompt-textarea[contenteditable="true"]', "#prompt-textarea", 'form div.ProseMirror[contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]:not([class*="leading-relaxed"])'], // 캔버스(문서) 편집창은 제외하고 아래 채팅 입력창을 고른다
    send: ['button[data-testid="send-button"]', "#composer-submit-button", 'button[aria-label="보내기"]', 'button[aria-label="Send prompt"]'],
  },
  gemini: {
    name: "Gemini",
    url: "https://gemini.google.com/app",
    input: ['rich-textarea div.ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]'],
    send: ["button.send-button", 'button[aria-label*="보내기"]', 'button[aria-label*="Send"]'],
  },
  claude: {
    name: "Claude",
    url: "https://claude.ai/new",
    input: ['div.ProseMirror[contenteditable="true"]', '[contenteditable="true"][data-testid*="chat-input"]'],
    send: ['button[aria-label*="Send"]', 'button[aria-label*="보내기"]', 'button[aria-label*="메시지 보내기"]'],
  },
};

// 이 주소로 가 있으면 로그인(또는 가입) 화면이라는 뜻 — 입력창을 10초 기다리지 않고 바로 "로그인 필요"로 알린다
const LOGIN_URL = /\/(login|log-in|signin|sign-in|auth|logout)|accounts\.google\.com|auth\.openai\.com|magic-link/i;
// 새 대화 화면의 경로 (이미 열려 있는 탭이 여기에 있으면 새 탭을 또 열지 않고 그 탭을 이어서 쓴다)
const NEW_CHAT_PATH = { chatgpt: "", gemini: "/app", claude: "/new" };

const LOGIN_WAIT_MS = 10 * 60 * 1000; // 로그인 기다리는 최대 시간
const CHAT_WAIT_MS = 60 * 60 * 1000; // 대화하며 "완성"까지 기다리는 최대 시간
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 응답이 안 오는 CDP 명령(창 상태에 따라 bringToFront 등)에 묶여 멈추지 않게 시간 제한을 둔다
const within = (p, ms) => Promise.race([p.catch(() => {}), sleep(ms)]);

// 한 번에 하나의 AI 대화만 지켜본다
// status: opening | needLogin | sending | chatting | done | closed | timeout | error
let state = { status: "idle" };
function getState() {
  const { client, ...pub } = state;
  return pub;
}

const firstMatch = (sels) => `(() => {
  for (const s of ${JSON.stringify(sels)}) { const el = document.querySelector(s); if (el && el.offsetParent !== null) return s; }
  return null;
})()`;

// 화면의 코드블록 중, 기다리는 결과 형식을 만족하는 마지막 JSON을 찾는다. 요청문 속 예시값은 제외한다.
//   post:   초안 {title, sections[]}            — 예시 "블로그 제목" / "1번 섹션 본문" 제외
//   format: 블로그 형식 {formatName, sections[]} — 예시 "형식 이름(예: …)" 제외
const CHECKS = {
  post: `j.title && Array.isArray(j.sections) && j.sections.length && j.title !== "블로그 제목" && j.sections[0] !== "1번 섹션 본문"`,
  format: `j.formatName && Array.isArray(j.sections) && j.sections.length && !String(j.formatName).startsWith("형식 이름")`,
};
// 화면에서 결과 JSON을 찾는다:
//  1) 코드블록(pre/code)  2) 대화 말풍선의 일반 글자 (예: 내가 이미 받아 둔 JSON을 대화창에 그냥 붙여넣은 경우)
// 두 가지 형식 모두 알아본다 — 초안 {title, sections[]} / 형식 {formatName, sections[]}.
// 요청문 속 예시값(제목 "블로그 제목", 형식 이름 "형식 이름(예: …)")은 제외한다. 결과는 {kind, json} 문자열.
const findResultJs = (marker) => `(() => {
  const isPost = (j) => j && j.title && Array.isArray(j.sections) && j.sections.length && j.title !== "블로그 제목" && j.sections[0] !== "1번 섹션 본문";
  const isFormat = (j) => j && j.formatName && Array.isArray(j.sections) && j.sections.length && !String(j.formatName).startsWith("형식 이름");
  // 글자 속에서 중괄호가 맞게 닫히는 {…} 덩어리들 (문자열 안의 중괄호는 무시)
  const objects = (text) => {
    const out = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "{") continue;
      let depth = 0, inStr = false, esc = false;
      for (let k = i; k < text.length; k++) {
        const c = text[k];
        if (inStr) { if (esc) esc = false; else if (c === "\\\\") esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) { out.push(text.slice(i, k + 1)); i = k; break; }
      }
    }
    return out;
  };
  const marker = ${JSON.stringify("MARKER")};
  const msgs = [...document.querySelectorAll('[data-message-author-role], [class*="group/user-message"], user-query, model-response, .query-text, [data-testid*="message"], .font-claude-response, [data-is-streaming]')];
  const pres = [...document.querySelectorAll("pre, code")];
  // 우리가 보낸 요청문(표식이 든 말풍선)을 찾으면, 그 뒤에 나온 말풍선·코드블록만 본다 → 이 대화에 예전부터 있던 JSON에는 반응하지 않는다
  let mi = -1;
  if (marker) msgs.forEach((m, i) => { if ((m.innerText || "").includes(marker)) mi = i; });
  const anchor = mi >= 0 ? msgs[mi] : null;
  const after = (el) => !anchor || (anchor !== el && !anchor.contains(el) && !!(anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  // 화면 순서(위→아래)로 정렬해서, 수정본이 여러 개 있어도 "가장 아래(마지막)" 글을 쓴다
  const els = [...pres.filter(after), ...(anchor ? msgs.slice(mi + 1) : msgs)];
  els.sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  const sources = els.map((el) => el.innerText || el.textContent || "");
  let count = 0, found = null; const sigs = [];
  for (let i = sources.length - 1; i >= 0; i--) {
    for (const o of objects(sources[i]).reverse()) {
      try {
        const j = JSON.parse(o);
        const kind = isPost(j) ? "post" : isFormat(j) ? "format" : "";
        if (!kind) continue;
        count++; sigs.push(o.length + ":" + o.slice(0, 40) + o.slice(-40));
        if (!found) found = { kind, json: j };
      } catch {}
    }
  }
  // 코드블록·말풍선에서 못 찾으면 화면 글자 전체에서 찾는다 (사이트마다 답변을 그리는 방식이 달라서 — 예: Claude는 긴 요청문을 첨부로 접어
  // 요청 번호가 안 보이거나, 답변 말풍선이 위 목록에 안 잡힌다). 요청 번호가 보이면 그 뒤만, [가져오기]로 부르면(ALL) 화면 전체에서.
  const ALL = false;
  if (!found) {
    const body = document.body.innerText || "";
    const at = marker ? body.lastIndexOf(marker) : -1;
    const seg = at >= 0 ? body.slice(at) : ALL ? body : "";
    for (const o of objects(seg).reverse()) {
      try {
        const j = JSON.parse(o);
        const kind = isPost(j) ? "post" : isFormat(j) ? "format" : "";
        if (!kind) continue;
        count++; sigs.push(o.length + ":" + o.slice(0, 40) + o.slice(-40));
        if (!found) found = { kind, json: j };
      } catch {}
    }
  }
  // 마지막 JSON 덩어리가 끝까지 안 와서(답변이 중간에 끊김) 읽을 수 없는지
  let broken = false;
  const cands = sources.filter((t) => /\{\s*"(title|formatName)"/.test(t));
  if (cands.length) {
    const lastC = cands[cands.length - 1];
    broken = !objects(lastC).some((o) => { try { const j = JSON.parse(o); return isPost(j) || isFormat(j); } catch { return false; } });
  }
  return JSON.stringify({ count, found, sigs, broken, markerFound: !!anchor });
})()`;

/**
 * 대화 탭을 실제로 화면 앞으로 가져오고(보이는 상태가 될 때까지 기다림), 비어 있으면(백그라운드에서 내용이 내려간 탭) 새로 불러온다.
 * 뒤에 숨어 있던 탭에 요청문을 넣으면 사용자가 아무것도 못 보고, 입력창을 못 찾는 일이 생긴다.
 */
async function showTab(id, client, site) {
  try { await fetch(`${session.CDP_URL}/json/activate/${id}`, { signal: AbortSignal.timeout(3000) }); } catch {}
  await within(client.send("Page.bringToFront"), 2000);
  for (let i = 0; i < 10; i++) {
    const vis = await client.eval("document.visibilityState").catch(() => "");
    if (vis === "visible") break;
    await sleep(300);
  }
  // 입력창도 대화 내용도 없으면(탭이 내려가서 비어 있음) 한 번 새로 불러온다
  const blank = await client.eval(`!${JSON.stringify(site.input)}.some((s) => document.querySelector(s)) && !document.querySelector('[data-message-author-role]')`).catch(() => false);
  if (blank) {
    await within(client.send("Page.reload"), 2000);
    await sleep(2500);
  }
}

/** 표식을 넣은 결과 찾기 식 */
const findResult = (marker) => findResultJs(marker).replace('"MARKER"', JSON.stringify(String(marker || "")));

async function targetAlive(targetId) {
  const list = await (await fetch(`${session.CDP_URL}/json/list`)).json();
  return list.some((t) => t.id === targetId);
}

// 입력창에 붙어 있는 "붙여넣은 텍스트" 첨부의 [제거] 버튼 (보내고 나면 사라진다)
const PASTED_CHIP = 'button[aria-label*="붙여넣은 텍스트 첨부 제거"], button[aria-label*="Remove pasted"]';
/** 요청문을 입력창에 넣는다. 붙여넣기 이벤트를 먼저 쓰고(줄바꿈이 그대로 살아서), 안 되면 직접 입력한다. */
async function putPrompt(client, sel, prompt) {
  await client.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    el.focus();
    const dt = new DataTransfer();
    dt.setData("text/plain", ${JSON.stringify(prompt)});
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  })()`);
  await sleep(600);
  const len = await client.eval(`(document.querySelector(${JSON.stringify(sel)}).innerText || "").trim().length`);
  // 긴 글을 붙여넣으면 ChatGPT는 입력창 대신 "붙여넣은 텍스트" 첨부로 바꿔 넣는다 — 그것도 들어간 것
  const attached = await client.eval(`!!document.querySelector('${PASTED_CHIP}')`).catch(() => false);
  if (len < 20 && !attached) {
    await client.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`);
    await client.send("Input.insertText", { text: prompt });
    await sleep(600);
  }
}

async function pressSend(client, site, sel) {
  const btn = await client.eval(firstMatch(site.send)).catch(() => null);
  if (btn) {
    await client.eval(`document.querySelector(${JSON.stringify(btn)}).click()`);
  } else {
    await client.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`);
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }
  await sleep(1500);
  // 입력창이 비었고 붙여넣은 첨부도 없어졌으면 보내진 것
  const sentNow = async () => {
    const left = await client.eval(`((document.querySelector(${JSON.stringify(sel)}) || {}).innerText || "").trim().length`).catch(() => 0);
    const chip = await client.eval(`!!document.querySelector('${PASTED_CHIP}')`).catch(() => false);
    return left < 3 && !chip;
  };
  // 붙여넣은 첨부를 처리하는 동안은 [보내기]가 안 먹을 수 있어서 몇 번 더 눌러본다
  for (let i = 0; i < 8; i++) {
    if (await sentNow()) return true;
    const b = await client.eval(firstMatch(site.send)).catch(() => null);
    if (b && i % 2 === 0) await client.eval(`document.querySelector(${JSON.stringify(b)}).click()`).catch(() => {});
    else {
      // 버튼이 안 보이거나 눌러도 안 가면 Enter로 보내 본다 (긴 글을 붙여넣은 직후엔 버튼이 늦게 살아나는 경우가 있다)
      await client.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).focus && document.querySelector(${JSON.stringify(sel)}).focus()`).catch(() => {});
      const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" }).catch(() => {});
      await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }).catch(() => {});
    }
    await sleep(1500);
  }
  return sentNow();
}

/**
 * 이미 열려 있는 이 AI의 "새 대화" 탭을 찾는다. 입력창이 보이고 비어 있으면 로그인된 상태 + 바로 쓸 수 있는 탭이라
 * 새 탭을 열지 않고 그대로 이어 쓴다. (이미 대화가 진행 중인 탭은 건드리지 않는다)
 */
// ---- 한 대화(탭)를 계속 쓴다: 처음 한 번만 새 대화를 만들고, 그 뒤로는 같은 탭에 이어서 보낸다 ----
const TABS_PATH = require("path").join(__dirname, "..", "data", "ai-tabs.json");
function readTabs() {
  try { return JSON.parse(require("fs").readFileSync(TABS_PATH, "utf-8")); } catch { return {}; }
}
const LAST_PATH = require("path").join(__dirname, "..", "data", "ai-last.json");
/** 마지막으로 글을 쓴 AI (이미지는 그 AI로 만든다). 모르면 chatgpt */
function lastWriteAi() {
  try { return JSON.parse(require("fs").readFileSync(LAST_PATH, "utf-8")).ai || "chatgpt"; } catch { return "chatgpt"; }
}
function rememberLast(ai) {
  try { require("fs").mkdirSync(require("path").dirname(LAST_PATH), { recursive: true }); require("fs").writeFileSync(LAST_PATH, JSON.stringify({ ai, at: Date.now() })); } catch {}
}

function rememberTab(ai, id) {
  const t = readTabs();
  t[ai] = id;
  try { require("fs").mkdirSync(require("path").dirname(TABS_PATH), { recursive: true }); require("fs").writeFileSync(TABS_PATH, JSON.stringify(t)); } catch {}
}

/**
 * 이 AI의 대화 탭을 구한다 (글쓰기·형식 분석·이미지 만들기가 모두 같은 탭을 쓴다).
 *  1) 지난번에 쓰던 대화 탭이 아직 그 AI 사이트로 열려 있으면 그대로 이어서 쓴다 (새 대화를 만들지 않는다)
 *  2) 없으면 이미 열려 있는 새 대화 탭 → 3) 그것도 없으면 새 탭 (처음 한 번)
 * @returns {Promise<{id, client, continued:boolean, reused:boolean}>}
 */
// 같은 AI의 탭을 동시에 두 번 만들지 않게 순서대로 처리한다 (미리 열기와 실제 시작이 겹칠 때)
let tabLock = Promise.resolve();
const newChatAt = {}; // AI별로 마지막에 새 대화를 연 시각
function acquireTab(ai, site, opts = {}) {
  const run = tabLock.then(() => acquireTabInner(ai, site, opts), () => acquireTabInner(ai, site, opts));
  tabLock = run.catch(() => {});
  return run;
}
async function acquireTabInner(ai, site, opts = {}) {
  const port = new URL(session.CDP_URL).port || "9222";
  const id = readTabs()[ai];
  if (id) {
    try {
      const list = await (await fetch(`${session.CDP_URL}/json/list`)).json();
      const t = list.find((x) => x.id === id && x.type === "page");
      if (t && (() => { try { return new URL(t.url).hostname === new URL(site.url).hostname && !LOGIN_URL.test(t.url); } catch { return false; } })()) {
        const client = await within(connectPage(`ws://localhost:${port}/devtools/page/${id}`), 3000);
        if (client && client.eval) {
          // 그 탭에 요청문을 넣을 입력창이 실제로 있어야 이어서 쓴다 (캔버스 화면·로딩 중·내용이 비워진 탭이면 쓰지 않고 새 대화를 만든다)
          let usable = false;
          for (let i = 0; i < 12 && !usable; i++) {
            usable = !!(await client.eval(firstMatch(site.input)).catch(() => null));
            if (!usable) await sleep(250);
          }
          if (usable && opts.newChat && Date.now() - (newChatAt[ai] || 0) > 90000) {
            // 글쓰기를 새로 시작할 때는 긴 예전 대화가 아니라 새 대화에서 시작한다 (대화가 길면 AI가 느려지고 JSON이 끊긴다)
            await within(client.send("Page.navigate", { url: site.url }), 4000);
            await sleep(1200);
            usable = false;
            for (let i = 0; i < 20 && !usable; i++) {
              usable = !!(await client.eval(firstMatch(site.input)).catch(() => null));
              if (!usable) await sleep(300);
            }
            newChatAt[ai] = Date.now();
          }
          if (usable) return { id, client, continued: !opts.newChat, reused: true };
          try { client.close(); } catch {}
        }
      }
    } catch {}
  }
  const reuse = await findReusableTab(ai, site);
  if (reuse) { rememberTab(ai, reuse.id); return { ...reuse, continued: false, reused: true }; }
  const version = await (await fetch(`${session.CDP_URL}/json/version`)).json();
  const browserWs = await connectPage(version.webSocketDebuggerUrl);
  // 빈 탭을 만든 뒤 붙고 나서 이동한다 (URL로 바로 만들면 붙은 연결이 처음 about:blank 화면에 묶여 있는 경우가 있다)
  const { targetId } = await browserWs.send("Target.createTarget", { url: "about:blank", newWindow: false });
  browserWs.close();
  const client = await connectPage(`ws://localhost:${port}/devtools/page/${targetId}`);
  await within(client.send("Page.navigate", { url: site.url }), 3000);
  rememberTab(ai, targetId);
  newChatAt[ai] = Date.now();
  return { id: targetId, client, continued: false, reused: false };
}

/** 대화 탭이 안 풀릴 때: 기억해 둔 탭을 버리고 새 탭을 하나 연다 */
async function freshTab(ai, site) {
  const port = new URL(session.CDP_URL).port || "9222";
  const version = await (await fetch(`${session.CDP_URL}/json/version`)).json();
  const browserWs = await connectPage(version.webSocketDebuggerUrl);
  const { targetId } = await browserWs.send("Target.createTarget", { url: "about:blank", newWindow: false });
  browserWs.close();
  const client = await connectPage(`ws://localhost:${port}/devtools/page/${targetId}`);
  await within(client.send("Page.navigate", { url: site.url }), 3000);
  rememberTab(ai, targetId);
  return { id: targetId, client };
}

async function findReusableTab(ai, site) {
  try {
    const list = await (await fetch(`${session.CDP_URL}/json/list`)).json();
    const host = new URL(site.url).hostname;
    const port = new URL(session.CDP_URL).port || "9222";
    for (const t of list.filter((x) => x.type === "page" && x.url).slice(0, 12)) {
      let u;
      try { u = new URL(t.url); } catch { continue; }
      if (u.hostname !== host) continue;
      if (u.pathname.replace(/\/$/, "") !== NEW_CHAT_PATH[ai]) continue; // 대화 중이거나 다른 화면
      const client = await within(connectPage(`ws://localhost:${port}/devtools/page/${t.id}`), 2500).catch(() => null);
      if (!client || !client.eval) continue;
      const sel = await Promise.race([client.eval(firstMatch(site.input)).catch(() => null), sleep(2000).then(() => null)]);
      const empty = sel ? await client.eval(`((document.querySelector(${JSON.stringify(sel)}) || {}).innerText || "").trim().length < 3`).catch(() => false) : false;
      if (sel && empty) return { id: t.id, client };
      client.close && client.close();
    }
  } catch {}
  return null;
}

/** AI 채팅 탭을 열고 요청문을 보낸 뒤, 결과 JSON이 나올 때까지 지켜본다 (바로 반환 — 진행은 getState()). */
async function start(ai, prompt, kind = "post", mode = "default") {
  const site = SITES[ai];
  if (!site) throw new Error("알 수 없는 AI예요: " + ai);
  if (state.client) state.client.close(); // 이전 대화 지켜보기는 그만둔다 (탭은 그대로 둠)
  if (kind === "post") rememberLast(ai); // 글쓰기로 쓴 AI를 기억해 둔다 (이미지 만들기에 쓴다)
  const s = (state = { status: "opening", ai, kind, mode, name: site.name, startedAt: Date.now() });

  (async () => {
    try {
      await session.ensureDebugChrome({ quick: true });
      const tab = await acquireTab(ai, site, { newChat: kind === "post" || kind === "format" }); // 글쓰기·형식 분석은 새 대화에서 시작
      let targetId = tab.id;
      let client = tab.client;
      s.reused = tab.reused;
      if (tab.continued) s.note = `이전에 쓰던 ${site.name} 대화 창에 이어서 보냈어요 (새 대화를 만들지 않았어요).`;
      else if (tab.reused) s.note = `이미 열려 있던 ${site.name} 탭(로그인 상태)을 이어서 썼어요.`;
      s.targetId = targetId;
      s.client = client;
      session.notifyChrome(`${site.name} 채팅 창`);
      require("./windowLayout").splitSoon([1500, 6000]); // 왼쪽: 이 프로그램 화면, 오른쪽: AI 채팅 (반반)
      await showTab(targetId, client, site); // 뒤에 숨어 있던 탭이면 앞으로 가져오고 보일 때까지 기다린다

      // 입력창이 생길 때까지 기다린다 (로그인이 안 돼 있으면 사용자가 로그인할 때까지)
      let sel = null;
      const loginDeadline = Date.now() + LOGIN_WAIT_MS;
      for (let i = 0; !sel; i++) {
        if (s !== state) return; // 다른 대화가 시작됨
        if (!(await targetAlive(targetId).catch(() => true))) return void (s.status = "closed");
        if (Date.now() > loginDeadline) return void Object.assign(s, { status: "timeout", error: "로그인을 기다리다 시간이 지났어요." });
        sel = await client.eval(firstMatch(site.input)).catch(() => null);
        if (!sel && i === 40) await within(client.send("Page.reload"), 2000); // 20초 동안 입력창이 없으면 한 번 새로고침
        if (!sel && i === 80 && s.status !== "needLogin") {
          // 40초가 지나도 안 되면 이 탭은 버리고 새 대화 탭으로 다시 시도한다
          try { client.close(); } catch {}
          const fresh = await freshTab(ai, site);
          targetId = fresh.id; client = fresh.client; s.targetId = targetId; s.client = client;
          s.note = `${site.name} 탭이 응답하지 않아 새 대화 탭으로 다시 열었어요.`;
          await showTab(targetId, client, site);
        }
        if (!sel) {
          // 주소가 로그인 화면이면 바로 알린다 (아니면 10초 넘게 입력창이 없을 때 로그인 화면으로 본다)
          let onLogin = false;
          if (i >= 3 && i % 2 === 1 && s.status !== "needLogin") onLogin = LOGIN_URL.test(String(await client.eval("location.href").catch(() => "")));
          if (onLogin || i === 20) {
            if (s.status !== "needLogin") session.notifyChrome(`${site.name} 로그인 화면 — 로그인하면 요청문이 자동으로 들어가요`);
            s.status = "needLogin";
          }
          await sleep(500);
        }
      }
      await sleep(800); // 입력창이 막 생긴 직후엔 이벤트를 못 받는 경우가 있다

      // 이어 쓰는 대화에는 예전 결과가 남아 있어서, 지금 보내기 전의 개수를 기억해 두고 "새로 늘어난" 결과만 받는다
      // 기준 개수: 대화가 다 그려져서 값이 안정될 때까지 (예전 글이 늦게 그려지는 걸 새 결과로 착각하지 않게)
      let baseline = 0, prevCount = -1, baseSigs = [];
      for (let t = 0; t < 8; t++) {
        let c = null;
        try { const r0 = JSON.parse(await client.eval(findResult(""))); c = r0.count; baseSigs = r0.sigs || []; } catch {}
        if (c !== null && c === prevCount) break;
        prevCount = c === null ? prevCount : c;
        baseline = prevCount < 0 ? 0 : prevCount;
        await sleep(300);
      }
      const marker = "req" + Math.random().toString(36).slice(2, 7);
      s.status = "sending";
      await putPrompt(client, sel, `${prompt}\n\n(요청 번호: ${marker})`);
      const sent = await pressSend(client, site, sel);
      s.status = "chatting";
      if (!sent) s.note = "요청문을 입력창에 넣었어요. 탭에서 [보내기]를 눌러주세요.";

      // 사용자가 대화를 마치고 "완성"이라고 하면 나오는 JSON을 기다린다 (스트리밍 중엔 JSON이 깨져 있어 통과 못 함,
      // 그래도 혹시 모르니 같은 결과가 두 번 연속 보일 때 확정)
      const chatDeadline = Date.now() + CHAT_WAIT_MS;
      let last = null, brokenSince = 0, recovers = 0, lastRecoverAt = 0, lastBodyLen = -1;
      const STOPBTN = `!!document.querySelector('button[data-testid="stop-button"], button[aria-label*="중지"], button[aria-label*="Stop"]')`;
      while (s === state) {
        if (client.closed || !(await targetAlive(targetId).catch(() => true))) return void (s.status = "closed");
        if (Date.now() > chatDeadline) return void (s.status = "timeout");
        let cur = null;
        try { cur = JSON.parse(await client.eval(findResult(marker))); } catch {}
        // 요청문이 보이면 그 뒤에 나온 결과만 / 아직 안 보이면(보내기 전·전송 실패) 기준 개수보다 늘어난 결과만
        // (긴 대화는 위쪽 말풍선이 화면에서 빠져 개수가 안 늘 수 있어서, 보내기 전에 없던 새 내용의 JSON이면 새 결과로 본다)
        const isNew = cur && cur.found && (cur.sigs || []).some((g) => !baseSigs.includes(g));
        const found = cur && cur.found && (cur.markerFound || cur.count > baseline || isNew) ? JSON.stringify(cur.found) : null;
        if (found && found === last) {
          const r = JSON.parse(found);
          s.kind = r.kind; // 글감으로 시작했는데 형식(분석) 결과가 온 경우 등, 실제로 받은 종류를 따른다
          s.result = r.json;
          s.status = "done";
          return;
        }
        last = found;
        // 마지막 JSON이 중간에 끊겨 있고 답변이 이미 멈춰 있으면(Gemini "대답이 중지되었습니다" 등), 자동으로 한 번 더 요청한다
        if (!found && cur && cur.broken) {
          // 화면이 8초 넘게 그대로이고(AI가 쓰는 중이 아님), 마지막 재요청 뒤 90초가 지났을 때만 다시 요청한다 (생각 중인 AI에게 계속 보내지 않게)
          const bodyLen = (await client.eval("document.body.innerText.length").catch(() => 0)) || 0;
          if (bodyLen !== lastBodyLen) { lastBodyLen = bodyLen; brokenSince = Date.now(); }
          const stopBtn = await client.eval(STOPBTN).catch(() => false);
          if (!stopBtn && Date.now() - brokenSince > 8000 && Date.now() - lastRecoverAt > 90000 && recovers < 3) {
            recovers++;
            lastRecoverAt = Date.now();
            brokenSince = Date.now();
            s.note = `AI가 보낸 JSON이 중간에 끊겨 있어서, 처음부터 끝까지 다시 보내달라고 자동으로 요청했어요 (${recovers}/3).`;
            try {
              const selNow = await client.eval(firstMatch(site.input));
              const left = (await client.eval(`((document.querySelector(${JSON.stringify(selNow)}) || {}).innerText || "").trim().length`).catch(() => 0)) || 0;
              if (left < 3) { // 입력창에 사용자가 쓰던 글이 있으면 건드리지 않는다
                await putPrompt(client, selNow, "방금 JSON이 중간에 끊겼어. 내용은 그대로 두고, 처음({)부터 끝(})까지 빠짐없이 코드블록 하나로 다시 보내줘. 다른 설명은 붙이지 마.");
                await pressSend(client, site, selNow);
              }
            } catch {}
          }
        } else brokenSince = 0;
        await sleep(2000);
      }
    } catch (e) {
      s.status = "error";
      s.error = e.message;
    } finally {
      if (s.client) s.client.close();
      delete s.client;
    }
  })();

  return getState();
}

/**
 * [완성본 가져오기]: 자동으로 안 넘어올 때 사용자가 누른다. 지금 AI 탭 화면 전체에서 마지막 결과 JSON을 바로 가져온다
 * (요청 번호·이전 결과 개수 같은 조건 없이)
 */
async function grab() {
  const id = state.targetId || readTabs()[state.ai || lastWriteAi()];
  if (!id) throw new Error("열려 있는 AI 대화 탭이 없어요.");
  const port = new URL(session.CDP_URL).port || "9222";
  const c = await connectPage(`ws://localhost:${port}/devtools/page/${id}`);
  try {
    const r = JSON.parse(await c.eval(findResult("").replace("const ALL = false;", "const ALL = true;")));
    if (!r.found) throw new Error(r.broken ? "AI 답의 JSON이 중간에 끊겨 있어요. AI에게 \"JSON을 처음부터 끝까지 다시 보내줘\"라고 한 뒤 다시 눌러주세요." : "AI 탭에서 완성된 JSON을 못 찾았어요. AI에게 \"완성\"이라고 보낸 뒤 JSON이 다 나오면 다시 눌러주세요.");
    if (state.client) try { state.client.close(); } catch {}
    state = { ...state, status: "done", kind: r.found.kind, result: r.found.json };
    delete state.client;
    return getState();
  } finally {
    c.close();
  }
}

/** 앱이 결과를 가져간 뒤 다시 가져가지 않게 표시 */
function markTaken() {
  if (state.status === "done") state.status = "taken";
}

/** 대화 중인 AI 탭을 앞으로 가져온다 */
async function focus() {
  if (!state.targetId) throw new Error("열려 있는 AI 대화가 없어요.");
  await fetch(`${session.CDP_URL}/json/activate/${state.targetId}`);
  session.notifyChrome(`${state.name} 채팅 창`);
}

/** 지켜보기를 멈춘다 (탭은 그대로 둠) */
function stop() {
  if (state.client) state.client.close();
  state = { status: "idle" };
}

/** AI 창을 미리 준비한다 (글감 본문을 모으는 동안 크롬·탭을 먼저 열어 둔다) */
async function prewarm(ai) {
  const site = SITES[ai];
  if (!site) return;
  await session.ensureDebugChrome({ quick: true });
  const tab = await acquireTab(ai, site, { newChat: true });
  try { tab.client.close(); } catch {}
  fetch(`${session.CDP_URL}/json/activate/${tab.id}`).catch(() => {});
}

/**
 * 한 번 묻고 답(JSON)만 받아 온다 — 이웃 추천 댓글처럼 프로그램이 알아서 쓰는 짧은 요청용.
 * 글쓰기 대화 탭과 섞이지 않게 따로 탭을 하나 두고, 매번 새 대화에서 묻는다.
 * @param {(j:any)=>boolean} accept 받은 JSON이 쓸 만한지 (예: 요청한 키가 다 있는지)
 * @returns {Promise<any>} 파싱된 JSON
 */
let askLock = Promise.resolve();
let askPending = 0;
const askIdleTimers = {};
function askWeb(ai, prompt, accept = () => true, { timeoutMs = 240000, background = false } = {}) {
  // 보내기가 안 먹었으면 새 대화에서 한 번 더 (탭이 덜 불러와졌거나 버튼이 늦게 살아난 경우)
  const go = () => askWebInner(ai, prompt, accept, timeoutMs, background)
    .catch((e) => (/보내지 못했/.test(e.message) ? askWebInner(ai, prompt, accept, timeoutMs, background) : Promise.reject(e)));
  askPending++;
  clearTimeout(askIdleTimers[ai]);
  const run = askLock.then(go, go);
  askLock = run.catch(() => {});
  run.finally(() => {
    // 1분 동안 더 부탁할 게 없으면 추천 댓글용 AI 탭을 닫는다 (AI 사이트는 탭 하나만으로도 메모리를 많이 써서 느린 컴퓨터가 버벅인다)
    if (--askPending === 0) askIdleTimers[ai] = setTimeout(() => closeAskTab(ai), 60000);
  }).catch(() => {});
  return run;
}
async function closeAskTab(ai) {
  if (askPending) return;
  const t = readTabs();
  const id = t["ask-" + ai];
  if (!id) return;
  try { await fetch(`${session.CDP_URL}/json/close/${id}`, { signal: AbortSignal.timeout(3000) }); } catch {}
  delete t["ask-" + ai];
  try { require("fs").writeFileSync(TABS_PATH, JSON.stringify(t)); } catch {}
}
async function askWebInner(ai, prompt, accept, timeoutMs, background) {
  const site = SITES[ai];
  if (!site) throw new Error("알 수 없는 AI예요: " + ai);
  await session.ensureDebugChrome({ quick: true });
  const port = new URL(session.CDP_URL).port || "9222";
  const key = "ask-" + ai;
  let id = readTabs()[key];
  let client = null;
  if (id) {
    const list = await (await fetch(`${session.CDP_URL}/json/list`)).json().catch(() => []);
    if (list.some((t) => t.id === id && t.type === "page")) client = await within(connectPage(`ws://localhost:${port}/devtools/page/${id}`), 3000);
    if (!client || !client.eval) client = null;
  }
  if (!client) {
    const version = await (await fetch(`${session.CDP_URL}/json/version`)).json();
    const browserWs = await connectPage(version.webSocketDebuggerUrl);
    const t = await browserWs.send("Target.createTarget", { url: "about:blank", newWindow: false });
    browserWs.close();
    id = t.targetId;
    client = await connectPage(`ws://localhost:${port}/devtools/page/${id}`);
    rememberTab(key, id);
  }
  try {
    await within(client.send("Page.navigate", { url: site.url }), 4000); // 매번 새 대화
    // 보이지 않는 탭에서는 입력·전송이 안 돼서 탭을 앞으로 가져온다.
    // 자동으로 만들 때(background)는 보내자마자 원래 보던 탭으로 되돌리고, 창 배치도 건드리지 않는다
    let prevTab = null;
    if (background) {
      try { prevTab = ((await (await fetch(`${session.CDP_URL}/json/list`)).json()).find((t) => t.type === "page" && t.id !== id) || {}).id || null; } catch {}
    }
    try { await fetch(`${session.CDP_URL}/json/activate/${id}`, { signal: AbortSignal.timeout(3000) }); } catch {}
    await within(client.send("Page.bringToFront"), 2000);
    for (let i = 0; i < 15; i++) {
      if ((await client.eval("document.visibilityState").catch(() => "")) === "visible") break;
      await sleep(200);
    }
    if (!background) require("./windowLayout").splitSoon([1500]);
    let sel = null;
    for (let i = 0; i < 60 && !sel; i++) {
      await sleep(500);
      sel = await client.eval(firstMatch(site.input)).catch(() => null);
      if (!sel && i >= 6 && LOGIN_URL.test(String(await client.eval("location.href").catch(() => "")))) {
        throw new Error(`${site.name}에 로그인이 필요해요. 열린 ${site.name} 탭에서 로그인한 뒤 다시 눌러주세요.`);
      }
    }
    if (!sel) throw new Error(`${site.name} 입력창을 찾지 못했어요. ${site.name} 탭을 확인해주세요.`);
    await sleep(700);
    // 지난번에 못 보내고 남은 입력·첨부가 있으면 지운다 (같이 보내지지 않게)
    await client.eval(`(() => {
      document.querySelectorAll('button[aria-label*="첨부 제거"], button[aria-label*="Remove"]').forEach((b) => b.click());
      const el = document.querySelector(${JSON.stringify(sel)});
      if (el && (el.innerText || "").trim()) { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); }
    })()`).catch(() => {});
    await sleep(400);
    const marker = "req" + Math.random().toString(36).slice(2, 7);
    await putPrompt(client, sel, prompt);
    // 요청 번호는 따로 입력한다 (긴 글은 첨부로 접혀서 화면 글자에 안 보이므로, 번호는 입력창 글자로 남겨야 답을 찾을 수 있다)
    await client.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`).catch(() => {});
    await client.send("Input.insertText", { text: `\n\n(요청 번호: ${marker})` });
    await sleep(500);
    const sentOk = await pressSend(client, site, sel);
    if (!sentOk && prevTab) try { await fetch(`${session.CDP_URL}/json/activate/${prevTab}`, { signal: AbortSignal.timeout(3000) }); } catch {}
    if (!sentOk) throw new Error(`${site.name}에 요청을 보내지 못했어요.`);
    // 요청 번호 뒤에 나온 글자에서, 중괄호가 맞게 닫힌 마지막 JSON을 찾는다. 답이 다 끝나고(중지 버튼 없음) 두 번 연속 같으면 확정
    const READ = `(() => {
      const t = document.body.innerText || "";
      const at = t.lastIndexOf(${JSON.stringify(marker)});
      const busy = !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="중지"], button[aria-label*="Stop"]');
      return JSON.stringify({ text: at >= 0 ? t.slice(at + ${marker.length}) : "", busy });
    })()`;
    const deadline = Date.now() + timeoutMs;
    const sentAt = Date.now();
    // Gemini는 탭이 화면에 보일 때만 답을 그려서, 답이 다 올 때까지는 이 탭을 앞에 둔다 (끝나면 원래 보던 탭으로)
    let last = "", shown = true;
    const backToPrev = async () => {
      if (shown && prevTab) try { await fetch(`${session.CDP_URL}/json/activate/${prevTab}`, { signal: AbortSignal.timeout(3000) }); } catch {}
    };
    while (Date.now() < deadline) {
      await sleep(2500);
      let r;
      try { r = JSON.parse(await client.eval(READ)); } catch { continue; }
      const j = lastJson(r.text);
      const sig = j ? JSON.stringify(j) : "";
      if (j && !r.busy && sig === last && accept(j)) { await backToPrev(); return j; }
      last = sig;
      // 그사이 다른 탭으로 바뀌어 답이 안 그려지고 있으면 다시 앞으로
      if (!j && Date.now() - sentAt > 8000 && (await client.eval("document.visibilityState").catch(() => "")) !== "visible") {
        try { await fetch(`${session.CDP_URL}/json/activate/${id}`, { signal: AbortSignal.timeout(3000) }); } catch {}
      }
    }
    await backToPrev();
    throw new Error(`${site.name} 답을 기다리다 시간이 지났어요.`);
  } finally {
    try { client.close(); } catch {}
  }
}
/** 글자 속에서 중괄호가 맞게 닫히는 마지막 JSON 객체 */
function lastJson(text) {
  let found = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let k = i; k < text.length; k++) {
      const c = text[k];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { found = JSON.parse(text.slice(i, k + 1)); i = k; } catch {}
        break;
      }
    }
  }
  return found;
}

module.exports = { _findResult: (m) => findResult(m), grab, askWeb, prewarm, freshTab, lastWriteAi, showTab, acquireTab, _h: { firstMatch, putPrompt, pressSend, targetAlive, within, sleep, SITES, LOGIN_URL }, start, getState, markTaken, focus, stop, SITES, findReusableTab };
