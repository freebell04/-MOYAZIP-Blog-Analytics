// ✏️ 마음에 안 드는 부분 다시 쓰기: 네이버 글쓰기 창에서 사용자가 드래그(선택)한 부분만 AI가 다시 쓰고, 그 부분만 바꿔 넣는다.
// (사진·다른 문단·사용자가 직접 고친 곳은 그대로 둔다)
//  - 선택한 글자 읽기: 네이버 에디터는 자체 선택을 그려서 브라우저 선택으로는 안 읽힌다 → 에디터에서 Ctrl+C 후 클립보드로 읽는다
//    (사용자 클립보드에 있던 글자는 끝나면 되돌려 둔다)
//  - 바꿔 넣기: 선택된 상태에서 새 글을 입력하면 에디터가 선택 부분을 바꿔준다
const { execFileSync } = require("child_process");
const session = require("./session");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isEditor = (u) => /PostWriteForm|postwrite|Redirect=Write|PostUpdateForm/i.test(u);

function getClipboard() {
  try { return execFileSync("powershell.exe", ["-NoProfile", "-Command", "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"], { timeout: 8000, windowsHide: true }).toString("utf8").replace(/\r\n/g, "\n").replace(/\n$/, ""); } catch { return ""; }
}
function setClipboard(text) {
  try { execFileSync("powershell.exe", ["-NoProfile", "-Command", "$t = [Console]::In.ReadToEnd(); if ($t) { Set-Clipboard -Value $t }"], { input: String(text || ""), timeout: 8000, windowsHide: true }); } catch {}
}

/** 열려 있는 네이버 글쓰기(또는 수정) 화면 {browser, page, frame} */
async function findEditor(only) {
  const { browser, context } = await session.openVisibleContext();
  const pages = context.pages().reverse();
  for (const p of pages) {
    if (!isEditor(p.url()) && !p.frames().some((f) => isEditor(f.url()))) continue;
    if (only && !p.url().includes(only)) continue; // (테스트용: 특정 주소의 창만)
    for (const f of p.frames()) {
      if (await f.$(".se-component").catch(() => null)) return { browser, page: p, frame: f };
    }
  }
  browser.close().catch(() => {});
  throw new Error("열려 있는 네이버 글쓰기 화면을 찾지 못했어요. 글쓰기 창을 열어 둔 채로 다시 눌러주세요.");
}

/** 지금 에디터에서 선택된 글자 (클립보드로 읽고, 원래 클립보드는 되돌린다) */
async function readSelection(page) {
  const backup = getClipboard();
  setClipboard("⁣"); // 빈 표시 (복사가 안 되면 이 글자가 그대로 남는다)
  await page.bringToFront().catch(() => {});
  await sleep(300);
  await page.keyboard.press("Control+c");
  await sleep(700);
  const text = getClipboard();
  setClipboard(backup);
  return text === "⁣" ? "" : text.trim();
}

/** 1) 선택한 부분을 읽고 AI에게 다시 쓰게 한다 → {old, text} */
async function start({ how = "", only } = {}) {
  const { browser, page, frame } = await findEditor(only);
  try {
    const old = await readSelection(page);
    if (!old) throw new Error("에디터에서 고치고 싶은 부분을 먼저 마우스로 드래그(선택)한 뒤 다시 눌러주세요.");
    if (old.length > 3000) throw new Error("선택한 부분이 너무 길어요. 한두 문단 정도만 선택해 주세요.");
    const title = await frame.evaluate(() => ((document.querySelector(".se-documentTitle .se-text-paragraph") || {}).innerText || "").replace(/​/g, "").trim()).catch(() => "");
    const lines = old.split("\n").length;
    const prompt = [
      `네이버 블로그 글${title ? ` "${title}"` : ""}의 한 부분을 다시 써줘.`,
      how ? `고치는 방향: ${how}` : "고치는 방향: 더 자연스럽고 읽기 쉽게, 내용은 정확하게.",
      "",
      "규칙:",
      "- 이 부분만 다시 써. 글 전체를 쓰지 마.",
      `- 원래 글과 비슷한 길이·줄 수(지금 ${lines}줄)와 같은 말투(해요체 등)로. 줄바꿈 위치도 비슷하게.`,
      "- 블로그 에디터에 그대로 입력할 거라 마크다운 기호(**, #, - 목록 기호)는 쓰지 마. 이모지는 원래 글에 있을 때만.",
      "- 표(도표): 고치는 방향에 '표'나 '도표'가 있거나 원래 글이 표였다면(표의 칸 글자가 한 줄씩 나열돼 있을 수 있어) 마크다운 표(| 칸 | 칸 |, 둘째 줄 |---|---|)로 써. 프로그램이 에디터에 진짜 표로 만들어 준다. 그 외에는 표를 쓰지 마.",
      "- 원래 글에 없는 사실·숫자는 지어내지 마.",
      "",
      "[원래 글]",
      old,
      "",
      '다음 JSON 형식으로만 답해 (다른 설명 없이): {"text": "다시 쓴 글 (줄바꿈은 \\n)"}',
    ].join("\n");
    // 다시 쓰기는 ChatGPT에게 보낸다 (로그인 크롬의 ChatGPT 탭, 매번 새 대화)
    const aiChat = require("./aiChat");
    const json = await aiChat.askWeb("chatgpt", prompt, (j) => typeof j.text === "string" && j.text.trim().length > 0, { background: true, timeoutMs: 180000 });
    await page.bringToFront().catch(() => {}); // AI 탭이 앞으로 나왔다가 돌아가므로, 글쓰기 창을 다시 앞으로
    const text = String(json.text).replace(/\\n/g, "\n").replace(/\*\*/g, "").trim();
    return { old, text };
  } finally {
    browser.close().catch(() => {});
  }
}

/** 2) 지금 선택된 부분을 새 글로 바꾼다 (선택이 풀렸으면 다시 선택하라고 알린다) */
async function apply({ old = "", text = "", only }) {
  if (!String(text).trim()) throw new Error("바꿔 넣을 글이 없어요.");
  const { browser, page, frame } = await findEditor(only);
  try {
    const cur = await readSelection(page);
    const norm = (s) => String(s || "").replace(/\s+/g, "");
    if (!cur) throw new Error("에디터에서 선택이 풀렸어요. 바꿀 부분을 다시 드래그(선택)한 뒤 [바꿔 넣기]를 눌러주세요.");
    const same = norm(cur) === norm(old);
    await page.bringToFront().catch(() => {});
    await sleep(200);
    // 마크다운 표(| a | b |)는 자리표시 줄([[TABLE_9xx]])로 먼저 쓰고, 다 쓴 뒤 그 자리에 진짜 네이버 표를 만든다
    const SEP = /^\|(\s*:?-{2,}:?\s*\|)+\s*$/;
    const src = String(text).split("\n");
    const out = [];
    const tables = [];
    for (let i = 0; i < src.length; i++) {
      if (src[i].trim().startsWith("|")) {
        const rows = [];
        while (i < src.length && src[i].trim().startsWith("|")) {
          if (!SEP.test(src[i].trim())) rows.push(src[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.replace(/\*\*/g, "").trim()));
          i++;
        }
        i--;
        if (rows.length) { out.push(`[[TABLE_${900 + tables.length}]]`); tables.push(rows); }
      } else out.push(src[i]);
    }
    for (let i = 0; i < out.length; i++) {
      if (out[i]) await page.keyboard.type(out[i], { delay: 5 });
      if (i < out.length - 1) await page.keyboard.press("Enter");
    }
    if (tables.length) {
      await sleep(600);
      const { insertTableAtPlaceholder } = require("./blogEditor");
      for (let k = 0; k < tables.length; k++) {
        // 이 자리표시 줄 앞에 이미 있는 표 개수 = 새로 만들 표의 문서 속 순서
        const docIndex = await frame.evaluate((mark) => {
          const comps = [...document.querySelectorAll(".se-component")];
          const at = comps.findIndex((c) => [...c.querySelectorAll(".se-text-paragraph")].some((p) => p.textContent.replace(/​/g, "").trim() === mark));
          return comps.slice(0, at).filter((c) => c.classList.contains("se-table")).length;
        }, `[[TABLE_${900 + k}]]`);
        await insertTableAtPlaceholder(frame, page, 900 + k, tables[k], docIndex);
      }
    }
    return { ok: true, sameSelection: same, tables: tables.length };
  } finally {
    browser.close().catch(() => {});
  }
}

module.exports = { start, apply };
