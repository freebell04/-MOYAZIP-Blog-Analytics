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
    input: ['#prompt-textarea[contenteditable="true"]', "#prompt-textarea", 'div.ProseMirror[contenteditable="true"]'],
    send: ['button[data-testid="send-button"]', "#composer-submit-button"],
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
const findResultJs = () => `(() => {
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
  const sources = [
    ...[...document.querySelectorAll("pre, code")].map((el) => el.innerText || el.textContent || ""),
    ...[...document.querySelectorAll('[data-message-author-role], user-query, model-response, .query-text, [data-testid*="message"]')].map((el) => el.innerText || ""),
  ];
  let count = 0, found = null;
  for (let i = sources.length - 1; i >= 0; i--) {
    for (const o of objects(sources[i]).reverse()) {
      try {
        const j = JSON.parse(o);
        const kind = isPost(j) ? "post" : isFormat(j) ? "format" : "";
        if (!kind) continue;
        count++;
        if (!found) found = { kind, json: j };
      } catch {}
    }
  }
  return JSON.stringify({ count, found });
})()`;

async function targetAlive(targetId) {
  const list = await (await fetch(`${session.CDP_URL}/json/list`)).json();
  return list.some((t) => t.id === targetId);
}

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
  if (len < 20) {
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
  // 입력창이 비었으면 보내진 것
  const left = await client.eval(`((document.querySelector(${JSON.stringify(sel)}) || {}).innerText || "").trim().length`).catch(() => 0);
  return left < 20;
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
async function acquireTab(ai, site) {
  const port = new URL(session.CDP_URL).port || "9222";
  const id = readTabs()[ai];
  if (id) {
    try {
      const list = await (await fetch(`${session.CDP_URL}/json/list`)).json();
      const t = list.find((x) => x.id === id && x.type === "page");
      if (t && (() => { try { return new URL(t.url).hostname === new URL(site.url).hostname && !LOGIN_URL.test(t.url); } catch { return false; } })()) {
        const client = await within(connectPage(`ws://localhost:${port}/devtools/page/${id}`), 3000);
        if (client && client.eval) return { id, client, continued: true, reused: true };
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
  return { id: targetId, client, continued: false, reused: false };
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
async function start(ai, prompt, kind = "post") {
  const site = SITES[ai];
  if (!site) throw new Error("알 수 없는 AI예요: " + ai);
  if (state.client) state.client.close(); // 이전 대화 지켜보기는 그만둔다 (탭은 그대로 둠)
  const s = (state = { status: "opening", ai, kind, name: site.name, startedAt: Date.now() });

  (async () => {
    try {
      await session.ensureDebugChrome();
      const tab = await acquireTab(ai, site);
      const targetId = tab.id;
      const client = tab.client;
      s.reused = tab.reused;
      if (tab.continued) s.note = `이전에 쓰던 ${site.name} 대화 창에 이어서 보냈어요 (새 대화를 만들지 않았어요).`;
      else if (tab.reused) s.note = `이미 열려 있던 ${site.name} 탭(로그인 상태)을 이어서 썼어요.`;
      s.targetId = targetId;
      s.client = client;
      session.notifyChrome(`${site.name} 채팅 창`);
      require("./windowLayout").splitSoon([1500, 6000]); // 왼쪽: 이 프로그램 화면, 오른쪽: AI 채팅 (반반)
      client.send("Page.bringToFront").catch(() => {}); // 기다리지 않는다 (창 상태에 따라 응답이 안 오기도 함)

      // 입력창이 생길 때까지 기다린다 (로그인이 안 돼 있으면 사용자가 로그인할 때까지)
      let sel = null;
      const loginDeadline = Date.now() + LOGIN_WAIT_MS;
      for (let i = 0; !sel; i++) {
        if (s !== state) return; // 다른 대화가 시작됨
        if (!(await targetAlive(targetId).catch(() => true))) return void (s.status = "closed");
        if (Date.now() > loginDeadline) return void Object.assign(s, { status: "timeout", error: "로그인을 기다리다 시간이 지났어요." });
        sel = await client.eval(firstMatch(site.input)).catch(() => null);
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
      let baseline = 0;
      try { baseline = JSON.parse(await client.eval(findResultJs())).count || 0; } catch {}
      s.status = "sending";
      await putPrompt(client, sel, prompt);
      const sent = await pressSend(client, site, sel);
      s.status = "chatting";
      if (!sent) s.note = "요청문을 입력창에 넣었어요. 탭에서 [보내기]를 눌러주세요.";

      // 사용자가 대화를 마치고 "완성"이라고 하면 나오는 JSON을 기다린다 (스트리밍 중엔 JSON이 깨져 있어 통과 못 함,
      // 그래도 혹시 모르니 같은 결과가 두 번 연속 보일 때 확정)
      const chatDeadline = Date.now() + CHAT_WAIT_MS;
      let last = null;
      while (s === state) {
        if (client.closed || !(await targetAlive(targetId).catch(() => true))) return void (s.status = "closed");
        if (Date.now() > chatDeadline) return void (s.status = "timeout");
        let cur = null;
        try { cur = JSON.parse(await client.eval(findResultJs())); } catch {}
        const found = cur && cur.found && cur.count > baseline ? JSON.stringify(cur.found) : null; // 보내기 전보다 늘어난 결과만
        if (found && found === last) {
          const r = JSON.parse(found);
          s.kind = r.kind; // 글감으로 시작했는데 형식(분석) 결과가 온 경우 등, 실제로 받은 종류를 따른다
          s.result = r.json;
          s.status = "done";
          return;
        }
        last = found;
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

module.exports = { acquireTab, _h: { firstMatch, putPrompt, pressSend, targetAlive, within, sleep, SITES, LOGIN_URL }, start, getState, markTaken, focus, stop, SITES, findReusableTab };
