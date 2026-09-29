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
const findResultJs = (kind) => `(() => {
  const blocks = [...document.querySelectorAll("pre, code")].map((el) => el.innerText || el.textContent || "");
  for (let i = blocks.length - 1; i >= 0; i--) {
    const m = blocks[i].match(/\\{[\\s\\S]*\\}/);
    if (!m) continue;
    try {
      const j = JSON.parse(m[0]);
      if (j && ${CHECKS[kind]}) return JSON.stringify(j);
    } catch {}
  }
  return null;
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

/** AI 채팅 탭을 열고 요청문을 보낸 뒤, 결과 JSON이 나올 때까지 지켜본다 (바로 반환 — 진행은 getState()). */
async function start(ai, prompt, kind = "post") {
  const site = SITES[ai];
  if (!site) throw new Error("알 수 없는 AI예요: " + ai);
  if (state.client) state.client.close(); // 이전 대화 지켜보기는 그만둔다 (탭은 그대로 둠)
  const s = (state = { status: "opening", ai, kind, name: site.name, startedAt: Date.now() });

  (async () => {
    try {
      await session.ensureDebugChrome();
      const version = await (await fetch(`${session.CDP_URL}/json/version`)).json();
      const browserWs = await connectPage(version.webSocketDebuggerUrl);
      // 빈 탭을 만든 뒤 붙고 나서 이동한다 (URL로 바로 만들면 붙은 연결이 처음 about:blank 화면에 묶여 있는 경우가 있다)
      const { targetId } = await browserWs.send("Target.createTarget", { url: "about:blank", newWindow: false });
      browserWs.close();
      s.targetId = targetId;
      const port = new URL(session.CDP_URL).port || "9222";
      const client = await connectPage(`ws://localhost:${port}/devtools/page/${targetId}`);
      s.client = client;
      // 응답(로드 완료)을 오래 기다리지 않는다 — 아래에서 입력창이 생길 때까지 어차피 확인하며 기다린다
      await within(client.send("Page.navigate", { url: site.url }), 3000);
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
          if (i === 20) s.status = "needLogin"; // 10초 넘게 입력창이 없으면 로그인 화면일 가능성이 크다
          await sleep(500);
        }
      }
      await sleep(800); // 입력창이 막 생긴 직후엔 이벤트를 못 받는 경우가 있다

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
        const found = await client.eval(findResultJs(kind)).catch(() => null);
        if (found && found === last) {
          s.result = JSON.parse(found);
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

module.exports = { start, getState, markTaken, SITES };
