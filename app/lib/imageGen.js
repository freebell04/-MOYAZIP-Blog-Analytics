// 챕터 본문 내용으로 ChatGPT가 이미지를 만들게 하고, 만들어진 이미지를 1201×673으로 맞춰 가져와 클립보드에 복사한다.
//   흐름: ChatGPT 탭을 열고 → 이미지 요청문을 넣고 → 이미지가 나올 때까지 기다리고 → 이미지를 받아 크기를 맞추고 →
//         저장 + 클립보드 복사 → (앱 카드에 썸네일로 보이고) 네이버 글쓰기 창에서 Ctrl+V
// 진행 상태는 이미지 고르기와 같은 상태(/api/images/pick/status)로 알려서, 챕터 카드에서 똑같이 보이게 한다.
const session = require("./session");
const aiChat = require("./aiChat");
const imagePick = require("./imagePick");
const { connectPage } = require("./like");

const W = 1201;
const H = 673;
const GEN_WAIT_MS = 4 * 60 * 1000; // 이미지가 만들어질 때까지 최대 4분
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const { firstMatch, putPrompt, pressSend, targetAlive, within, sleep, SITES, LOGIN_URL } = aiChat._h;

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
    "",
    `[소제목] ${String(heading || "").slice(0, 120)}`,
    "[본문]",
    plainBody(body).slice(0, 1200),
  ].join("\n");

// 대화 화면에서 "내용이 있는 큰 이미지"들의 주소
const LIST_IMGS = `[...document.querySelectorAll("img")].filter((i) => {
  const r = i.getBoundingClientRect();
  const u = (i.currentSrc || i.src || "") + " " + (i.alt || "");
  return i.complete && i.naturalWidth >= 500 && r.width >= 250 && r.height >= 150 && !/avatar|profile|logo|favicon|sprite/i.test(u);
}).map((i) => i.currentSrc || i.src)`;
const GENERATING = `!!document.querySelector('button[data-testid="stop-button"], button[aria-label*="중지"], button[aria-label*="Stop"]')`;
const FETCH_DATAURL = (src) => `(async () => {
  const r = await fetch(${JSON.stringify(src)}, { credentials: "include" });
  const b = await r.blob();
  return await new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = rej; f.readAsDataURL(b); });
})()`;

// 글을 쓰던 ChatGPT 대화 탭을 그대로 이어서 쓴다 (없을 때만 새 대화를 만든다)
const openTab = (site) => aiChat.acquireTab("chatgpt", site);

/** 이미지 만들기를 시작한다 (바로 반환 — 진행은 이미지 고르기와 같은 상태로 확인) */
async function start({ chapter, heading, body, style = "auto", paste = true }) {
  if (busy) throw new Error("이미 이미지를 만드는 중이에요. 끝난 뒤에 다시 눌러주세요.");
  if (!String(body || "").trim()) throw new Error("이 챕터의 본문이 비어 있어요.");
  busy = true;
  const set = (o) => imagePick.setGenState({ chapter, ...o });
  set({ status: "generating", note: "ChatGPT 창을 여는 중이에요..." });

  (async () => {
    let client;
    try {
      await session.ensureDebugChrome();
      const site = SITES.chatgpt;
      const tab = await openTab(site);
      client = tab.client;
      session.notifyChrome("ChatGPT 이미지 만드는 창");
      require("./windowLayout").splitSoon([1500, 6000]);
      client.send("Page.bringToFront").catch(() => {});

      // 입력창이 생길 때까지 (로그인이 안 돼 있으면 사용자가 로그인할 때까지)
      let sel = null;
      const loginDeadline = Date.now() + LOGIN_WAIT_MS;
      for (let i = 0; !sel; i++) {
        if (Date.now() > loginDeadline) throw new Error("ChatGPT 로그인을 기다리다 시간이 지났어요.");
        if (!(await targetAlive(tab.id).catch(() => true))) throw new Error("ChatGPT 창이 닫혀서 멈췄어요.");
        sel = await client.eval(firstMatch(site.input)).catch(() => null);
        if (!sel) {
          if (i >= 3 && i % 2 === 1 && LOGIN_URL.test(String(await client.eval("location.href").catch(() => "")))) {
            set({ status: "generating", note: "ChatGPT에 로그인해주세요 (처음 한 번만). 로그인하면 이미지 요청이 자동으로 들어가요." });
            if (i === 3) session.notifyChrome("ChatGPT 로그인 화면 — 로그인하면 이미지 요청이 자동으로 들어가요");
          }
          await sleep(500);
        }
      }
      await sleep(800);

      const before = new Set((await client.eval(LIST_IMGS).catch(() => [])) || []);
      set({ status: "generating", note: "이미지를 요청했어요. ChatGPT가 만드는 중이에요 (1~2분)..." });
      await putPrompt(client, sel, buildPrompt(heading, body, style));
      await pressSend(client, site, sel);

      // 새 이미지가 나타나고, 생성이 끝나서(중지 버튼이 없어지고) 같은 이미지가 두 번 연속 보일 때까지
      const deadline = Date.now() + GEN_WAIT_MS;
      let last = "";
      let src = "";
      while (Date.now() < deadline) {
        if (!(await targetAlive(tab.id).catch(() => true))) throw new Error("ChatGPT 창이 닫혀서 멈췄어요.");
        await sleep(3000);
        const imgs = ((await client.eval(LIST_IMGS).catch(() => [])) || []).filter((u) => !before.has(u));
        const cand = imgs[imgs.length - 1] || "";
        const generating = await client.eval(GENERATING).catch(() => false);
        if (cand && !generating && cand === last) { src = cand; break; }
        last = cand;
      }
      if (!src) throw new Error("이미지가 만들어지지 않았어요. ChatGPT 창에서 이미지 생성이 되는지(요금제·사용 한도) 확인해주세요.");

      set({ status: "generating", note: "이미지를 가져와 1201×673으로 맞추는 중이에요..." });
      const dataUrl = await client.eval(FETCH_DATAURL(src));
      const m = String(dataUrl || "").match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
      if (!m) throw new Error("만들어진 이미지를 가져오지 못했어요.");
      const { png, w, h } = await imagePick.toPngSized(Buffer.from(m[2], "base64"), m[1], W, H);
      const file = imagePick.savePng(png);
      await imagePick.copyImageToClipboard(file);
      // 일단 에디터에 붙여넣는 것까지 해 준다 (내 템플릿 글의 해당 블록 맨 아래). 안 되면 복사된 상태로 두고 이유를 알린다
      let pasted = { ok: false, reason: "" };
      if (paste) {
        set({ status: "generating", note: "이미지를 글쓰기 창에 붙여넣는 중이에요..." });
        pasted = await require("./editorPaste").pasteImageAtChapter(chapter).catch((e) => ({ ok: false, reason: e.message }));
      }
      imagePick.adoptCopied({ chapter, file, quality: `AI가 만든 이미지 ${w}×${h}`, width: w, height: h, pasted: !!pasted.ok, pasteNote: pasted.ok ? "" : pasted.reason || "" });
    } catch (e) {
      set({ status: "error", error: e.message });
    } finally {
      busy = false;
      try { client && client.close(); } catch {}
    }
  })();

  return { started: true };
}

module.exports = { start, buildPrompt, STYLES, W, H, isBusy: () => busy };
