// 챕터 본문 내용으로 AI(ChatGPT 또는 Gemini)가 이미지를 만들게 하고, 만들어진 이미지를 1201×673으로 맞춰 가져와 클립보드에 복사·붙여넣는다.
//   어느 AI로 만들지: 마지막으로 글을 쓴 AI (ChatGPT → ChatGPT, Gemini → Gemini). Claude는 이미지를 못 만들어서 ChatGPT. 기본은 ChatGPT.
//   흐름: 그 AI의 대화 탭(글 쓰던 탭)을 앞으로 가져오고 → 이미지 요청문을 입력창에 넣어 두고(보내지 않음) →
//         사용자가 대화하며 이미지를 다듬은 뒤 "완성"이라고 보내면 → 마지막 이미지를 받아 크기를 맞추고 →
//         저장 + 클립보드 복사 + 글쓰기 창에 붙여넣기 (앱 카드에 썸네일로 보임)
// 진행 상태는 이미지 고르기와 같은 상태(/api/images/pick/status)로 알려서, 챕터 카드에서 똑같이 보이게 한다.
const session = require("./session");
const aiChat = require("./aiChat");
const imagePick = require("./imagePick");

const W = 1201;
const H = 673;
const CHAT_WAIT_MS = 60 * 60 * 1000; // 사용자가 대화하며 이미지를 다듬고 "완성"이라고 할 때까지 최대 1시간
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const { firstMatch, putPrompt, targetAlive, sleep, SITES, LOGIN_URL } = aiChat._h;

// AI별로 화면에서 "내가 보낸 말풍선"과 "만들어진 이미지"를 찾는 방법
const AIS = {
  chatgpt: {
    name: "ChatGPT",
    // (ChatGPT 화면 구조가 바뀌어서 예전 이름표(data-message-author-role)와 새 이름표(group/user-message)를 함께 본다)
    userSel: '[data-message-author-role="user"], [class*="group/user-message"]',
    imgSel: "img",
  },
  gemini: {
    name: "Gemini",
    userSel: "user-query",
    imgSel: 'img[alt*="AI로 생성"], model-response img, generated-image img, single-image img', // Gemini가 만든 이미지는 alt가 ", AI로 생성" (직접 확인한 구조)
  },
};
/** 마지막으로 글 쓴 AI → 이미지를 만들 AI. Gemini면 Gemini, 그 밖(ChatGPT·Claude·모름)은 ChatGPT */
const pickAi = (ai) => (ai === "gemini" ? "gemini" : "chatgpt");

let busy = false;

/** 이미지 요청문에는 표 기호(|)·굵게(**) 같은 표시를 풀어서 읽기 쉬운 글로 넣는다 */
function plainBody(t) {
  return String(t || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^\|\s*:?-{2,}/.test(l))
    .map((l) => (l.startsWith("|") ? l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(": ") : l))
    .join("\n")
    .replace(/\*\*/g, "");
}

// 고를 수 있는 스타일 (화면의 "AI 이미지 스타일"과 같은 이름). 자동 = 내용에 어울리게 AI가 정한다
const STYLES = {
  auto: "밝고 깔끔한 분위기의 일러스트 또는 사진 느낌으로",
  photo: "실제 사진처럼 자연스러운 사진 스타일로",
  illust: "부드러운 색감의 깔끔한 일러스트 스타일로",
  watercolor: "수채화 느낌의 따뜻한 그림 스타일로",
  cartoon: "귀여운 3D 카툰 스타일로",
  flat: "단순하고 깔끔한 미니멀 플랫 일러스트 스타일로",
};
const buildPrompt = (heading, body, style = "auto") =>
  [
    "다음은 내가 쓰는 블로그 글의 한 부분이야. 이 내용을 한눈에 보여주는 블로그 삽화 이미지를 만들어줘.",
    "- 가로로 넓은 16:9 비율 (1201×673 픽셀로 쓸 거야).",
    `- 이미지 안에 글자(텍스트)는 넣지 마. ${STYLES[style] || STYLES.auto}.`,
    "- 한 장면으로 최대한 표현해줘. 꼭 필요하면 2개 장면을 화면 분할해서 보여줘도 돼 (3개 이상으로 쪼개지는 마).",
    "- 설명 없이 바로 이미지를 만들어줘.",
    "- 내가 \"완성\"이라고 말하기 전까지는 이미지를 최종 확정하지 말고, 내 수정 요청(스타일·장면·색감 등)을 기다려서 반영해줘.",
    "",
    `[소제목] ${String(heading || "").slice(0, 120)}`,
    "[본문]",
    plainBody(body).slice(0, 1200),
  ].join("\n");

// 대화 화면에서 "내용이 있는 큰 이미지"들의 주소
const LIST_IMGS = (imgSel) => `[...document.querySelectorAll(${JSON.stringify(imgSel)})].filter((i) => {
  const r = i.getBoundingClientRect();
  const u = (i.currentSrc || i.src || "") + " " + (i.alt || "");
  return i.complete && i.naturalWidth >= 500 && r.width >= 250 && r.height >= 150 && !/avatar|profile|logo|favicon|sprite/i.test(u);
}).map((i) => i.currentSrc || i.src)`;
// 사용자가 보낸 메시지 중 "완성"(만) 쓴 것의 개수 (안쪽에 겹쳐 있는 같은 말풍선은 한 번만 센다)
const DONE_COUNT = (userSel) => `(() => {
  const sel = ${JSON.stringify(userSel)};
  return [...document.querySelectorAll(sel)]
    .filter((e) => !(e.parentElement && e.parentElement.closest(sel)))
    // 말풍선 글에서 안 보이는 앞머리("내가 한 말", "말씀하신 내용")를 빼고, Gemini처럼 같은 글이 두 번 겹쳐 들어 있어도(줄마다) 전부 "완성"이면 센다
    .filter((e) => {
      const lines = (e.innerText || "").trim().replace(/^(?:내가 한 말|말씀하신 내용)[:\\s]*/, "").split("\\n").map((s) => s.trim()).filter(Boolean);
      return lines.length > 0 && lines.every((s) => /^완성[\\s.!~]*$/.test(s));
    }).length;
})()`;
const GENERATING = `!!document.querySelector('button[data-testid="stop-button"], button[aria-label*="중지"], button[aria-label*="Stop"]')`;
const FETCH_DATAURL = (src) => `(async () => {
  const r = await fetch(${JSON.stringify(src)}, { credentials: "include" });
  const b = await r.blob();
  return await new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });
})()`;
// 이미지를 직접 못 받을 때(다른 사이트 주소라 막힌 경우): 화면에 보이는 그 이미지를 그대로 캡처한다
const SHOT_RECT = (src) => `(() => {
  const i = [...document.querySelectorAll("img")].find((x) => (x.currentSrc || x.src) === ${JSON.stringify(src)});
  if (!i) return null;
  i.scrollIntoView({ block: "center" });
  const r = i.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
})()`;

/** 이미지 주소의 이미지를 {data:base64, mime}으로 받는다. 직접 받기가 안 되면 화면 캡처로 받는다 */
async function grabImage(client, src) {
  try {
    const dataUrl = await client.eval(FETCH_DATAURL(src));
    const m = String(dataUrl || "").match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (m) return { mime: m[1], data: m[2] };
  } catch {}
  const rect = await client.eval(SHOT_RECT(src));
  if (!rect) throw new Error("만들어진 이미지를 찾지 못했어요.");
  await sleep(500);
  const shot = await client.send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 2 }, captureBeyondViewport: true });
  if (!shot || !shot.data) throw new Error("만들어진 이미지를 가져오지 못했어요.");
  return { mime: "image/png", data: shot.data };
}

/** 이미지 만들기를 시작한다 (바로 반환 — 진행은 이미지 고르기와 같은 상태로 확인) */
let gen = 0; // 이미지 만들기 번호 (새로 시작하면 앞의 기다림은 끝난다)
function cancel() {
  gen++;
  busy = false;
}

async function start({ chapter, heading, body, style = "auto", paste = true, ai = "chatgpt" }) {
  if (!String(body || "").trim()) throw new Error("이 챕터의 본문이 비어 있어요.");
  const key = pickAi(ai);
  const cfg = AIS[key];
  const token = ++gen; // 이미 다른 챕터를 기다리는 중이었다면 그건 그만두고 이번 것을 한다
  busy = true;
  const set = (o) => { if (token === gen) imagePick.setGenState({ chapter, ...o }); };
  set({ status: "generating", note: `${cfg.name} 창을 여는 중이에요...` });

  (async () => {
    let client;
    try {
      await session.ensureDebugChrome();
      const site = SITES[key];
      // 글을 쓰던 그 AI의 대화 탭을 그대로 이어서 쓴다 (없을 때만 새 대화를 만든다)
      const tab = await aiChat.acquireTab(key, site);
      client = tab.client;
      session.notifyChrome(`${cfg.name} 이미지 만드는 창`);
      require("./windowLayout").splitSoon([1500, 6000]);
      await aiChat.showTab(tab.id, client, site); // 뒤에 숨어 있던 탭이면 앞으로 가져오고 보일 때까지 기다린다

      // 입력창이 생길 때까지 (로그인이 안 돼 있으면 사용자가 로그인할 때까지)
      let sel = null;
      const loginDeadline = Date.now() + LOGIN_WAIT_MS;
      for (let i = 0; !sel; i++) {
        if (Date.now() > loginDeadline) throw new Error(`${cfg.name} 로그인을 기다리다 시간이 지났어요.`);
        if (!(await targetAlive(tab.id).catch(() => true))) throw new Error(`${cfg.name} 창이 닫혀서 멈췄어요.`);
        sel = await client.eval(firstMatch(site.input)).catch(() => null);
        if (!sel && i === 40) await aiChat._h.within(client.send("Page.reload"), 2000);
        if (!sel && i === 80 && !LOGIN_URL.test(String(await client.eval("location.href").catch(() => "")))) {
          try { client.close(); } catch {}
          const fresh = await aiChat.freshTab(key, site); // 응답 없는 탭은 버리고 새 대화 탭으로
          tab.id = fresh.id; client = fresh.client;
          await aiChat.showTab(fresh.id, client, site);
        }
        if (!sel) {
          if (i >= 3 && i % 2 === 1 && LOGIN_URL.test(String(await client.eval("location.href").catch(() => "")))) {
            set({ status: "generating", note: `${cfg.name}에 로그인해주세요 (처음 한 번만). 로그인하면 이미지 요청이 자동으로 들어가요.` });
            if (i === 3) session.notifyChrome(`${cfg.name} 로그인 화면 — 로그인하면 이미지 요청이 자동으로 들어가요`);
          }
          await sleep(500);
        }
      }
      await sleep(800);

      // 이 대화에 이미 있던 이미지·"완성" 메시지는 기억해 두고, 이번에 새로 생긴 것만 본다
      const before = new Set((await client.eval(LIST_IMGS(cfg.imgSel)).catch(() => [])) || []);
      let doneBefore = (await client.eval(DONE_COUNT(cfg.userSel)).catch(() => 0)) || 0;

      // 요청문을 입력창에 넣어 두기만 하고 보내지는 않는다 → 사용자가 내용을 고치거나 덧붙여서 직접 보내고, 대화하며 이미지를 다듬는다
      await putPrompt(client, sel, buildPrompt(heading, body, style));
      const putLen = (await client.eval(`((document.querySelector(${JSON.stringify(sel)}) || {}).innerText || "").trim().length`).catch(() => 0)) || 0;
      if (putLen < 20) throw new Error(`요청문을 ${cfg.name} 입력창에 넣지 못했어요. ${cfg.name} 창을 확인하고(다른 화면이면 새 대화로 바꿔서) 다시 눌러주세요.`);
      set({ status: "generating", waiting: true, note: `이미지 요청문을 ${cfg.name} 입력창에 넣어 뒀어요. 필요하면 내용을 고쳐서 보내고, 이미지가 마음에 들 때까지 대화한 뒤 "완성"이라고 보내세요. 그러면 글쓰기 창에 붙여넣어요.` });

      // 사용자가 "완성"이라고 보낼 때까지 기다린다 (대화하며 다듬는 시간은 오래 걸려도 된다)
      const deadline = Date.now() + CHAT_WAIT_MS;
      let src = "";
      for (;;) {
        if (token !== gen) return; // 다른 챕터의 이미지 만들기가 시작됐거나 중단됨
        if (Date.now() > deadline) throw new Error('"완성"을 기다리다 시간이 지났어요. 다시 [AI로 이미지 만들기]를 눌러주세요.');
        if (!(await targetAlive(tab.id).catch(() => true))) throw new Error(`${cfg.name} 창이 닫혀서 멈췄어요.`);
        await sleep(2000);
        if (((await client.eval(DONE_COUNT(cfg.userSel)).catch(() => 0)) || 0) <= doneBefore) continue;
        // "완성"이 왔다 → 이미지가 아직 만들어지는 중이면 끝날 때까지 기다리고(최대 3분), 가장 마지막 새 이미지를 쓴다
        set({ status: "generating", note: '"완성"을 확인했어요. 마지막 이미지를 가져오는 중이에요...' });
        for (let w = 0; w < 90 && (await client.eval(GENERATING).catch(() => false)); w++) await sleep(2000);
        await sleep(1500);
        const imgs = ((await client.eval(LIST_IMGS(cfg.imgSel)).catch(() => [])) || []).filter((u) => !before.has(u));
        src = imgs[imgs.length - 1] || "";
        if (src) break;
        set({ status: "generating", waiting: true, note: '아직 새 이미지가 보이지 않아요. 이미지가 만들어진 뒤 "완성"이라고 다시 보내주세요.' });
        // 이번 "완성"은 처리한 것으로 치고, 다음 "완성"을 기다린다
        doneBefore = (await client.eval(DONE_COUNT(cfg.userSel)).catch(() => doneBefore)) || doneBefore;
      }

      set({ status: "generating", note: "이미지를 가져와 1201×673으로 맞추는 중이에요..." });
      const img = await grabImage(client, src);
      const { png, w, h } = await imagePick.toPngSized(Buffer.from(img.data, "base64"), img.mime, W, H);
      const file = imagePick.savePng(png);
      await imagePick.copyImageToClipboard(file);
      // 일단 에디터에 붙여넣는 것까지 해 준다 (내 템플릿 글의 해당 블록 맨 아래). 안 되면 복사된 상태로 두고 이유를 알린다
      let pasted = { ok: false, reason: "" };
      if (paste) {
        set({ status: "generating", note: "이미지를 글쓰기 창에 붙여넣는 중이에요..." });
        pasted = await require("./editorPaste").pasteImageAtChapter(chapter).catch((e) => ({ ok: false, reason: e.message }));
      }
      imagePick.adoptCopied({ chapter, file, quality: `${cfg.name}가 만든 이미지 ${w}×${h}`, width: w, height: h, pasted: !!pasted.ok, pasteNote: pasted.ok ? "" : pasted.reason || "" });
    } catch (e) {
      if (token === gen) set({ status: "error", error: e.message });
    } finally {
      if (token === gen) busy = false;
      try { client && client.close(); } catch {}
    }
  })();

  return { started: true };
}

module.exports = { start, cancel, pickAi, AIS, buildPrompt, STYLES, W, H, isBusy: () => busy };
