// 이미 열려 있는 네이버 글쓰기 창에서, 내 템플릿의 ꒰N꒱ 블록 맨 아래(그 블록의 마지막 글 아래)에 클립보드의 이미지를 붙여넣는다.
//  - 내 템플릿 모드(꒰①꒱~꒰⑥꒱ 블록이 있는 글)에서만 동작한다. 못 찾으면 아무것도 하지 않고 이유를 돌려준다.
//  - 이미지는 미리 윈도우 클립보드에 복사돼 있어야 한다 (imagePick.copyImageToClipboard).
const session = require("./session");

const pastedChapters = new Set(); // 이미 이미지를 붙여넣은 챕터 (다시 붙이면 앞의 것을 지우고 바꾼다)
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥"];

// 에디터 프레임 안에서: 해당 번호의 블록을 찾아 "그 블록의 마지막 글 문단"에 표시(data-nbh-paste)를 단다.
// 블록 = ꒰N꒱ 글 컴포넌트 ~ 다음 구분선 직전. (설명 사이에 표가 들어 있으면 그 표 뒤의 마지막 글 문단)
const MARK_JS = (n) => `(() => {
  document.querySelectorAll("[data-nbh-paste]").forEach((e) => e.removeAttribute("data-nbh-paste"));
  const comps = [...document.querySelectorAll(".se-component")];
  const mk = comps.findIndex((c) => [...c.querySelectorAll(".se-text-paragraph")].some((p) => p.textContent.replace(/\\u200b/g, "").trim() === ${JSON.stringify("꒰" + n + "꒱")}));
  if (mk < 0) return "block-not-found";
  let last = -1;
  for (let i = mk; i < comps.length; i++) {
    if (i > mk && comps[i].classList.contains("se-horizontalLine")) break;
    if (comps[i].classList.contains("se-text") || comps[i].querySelector(".se-text-paragraph")) {
      if (!comps[i].classList.contains("se-table") && !comps[i].classList.contains("se-quotation")) last = i;
    }
  }
  if (last < 0) return "text-not-found";
  const paras = comps[last].querySelectorAll(".se-text-paragraph");
  const p = paras[paras.length - 1];
  p.setAttribute("data-nbh-paste", "1");
  return "ok";
})()`;
const IMG_COUNT_JS = `document.querySelectorAll(".se-component.se-image").length`;

/** @returns {Promise<{ok:boolean, reason?:string}>} */
async function pasteImageAtChapter(chapter) {
  const n = CIRCLED[chapter];
  if (!n) return { ok: false, reason: "내 템플릿의 본문 블록(①~⑥) 범위를 벗어난 챕터예요." };
  try {
    if (require("./blogEditor").isBusy()) return { ok: false, reason: "글이 자동으로 입력되는 중이라 붙여넣지 않았어요." };
  } catch {}
  const { browser, context } = await session.openVisibleContext();
  try {
    const page = context.pages().reverse().find((p) => p.frames().some((f) => f.url().includes("PostWriteForm")));
    if (!page) return { ok: false, reason: "열려 있는 네이버 글쓰기 창을 찾지 못했어요." };
    const f = page.frames().find((x) => x.url().includes("PostWriteForm"));
    const mark = await f.evaluate(MARK_JS(n));
    if (mark !== "ok") return { ok: false, reason: mark === "block-not-found" ? `글쓰기 창에서 ꒰${n}꒱ 블록을 찾지 못했어요 (내 템플릿으로 쓴 글이 맞는지 확인해주세요).` : "그 블록의 글 칸을 찾지 못했어요." };
    // 이 챕터에 앞서 붙여넣은 이미지가 있으면 먼저 지운다 (다른 이미지로 바꿀 때) — 블록 맨 아래 글 칸 바로 다음 칸이 이미지일 때만
    if (pastedChapters.has(chapter)) {
      const removed = await f.evaluate(() => {
        const p = document.querySelector('[data-nbh-paste="1"]');
        const next = p && p.closest(".se-component") && p.closest(".se-component").nextElementSibling;
        if (!next || !next.classList.contains("se-image")) return false;
        next.scrollIntoView({ block: "center" });
        next.setAttribute("data-nbh-del", "1");
        return true;
      });
      if (removed) {
        await f.locator('[data-nbh-del="1"]').first().click({ timeout: 5000 }).catch(() => {});
        await page.keyboard.press("Delete");
        await page.waitForTimeout(400);
        await f.evaluate(() => document.querySelectorAll("[data-nbh-del]").forEach((e) => e.removeAttribute("data-nbh-del")));
        await f.evaluate(MARK_JS(n)); // 표시가 지워졌을 수 있어 다시 단다
      }
    }
    const before = await f.evaluate(IMG_COUNT_JS);
    await page.bringToFront().catch(() => {});
    const para = f.locator('[data-nbh-paste="1"]').first();
    await para.scrollIntoViewIfNeeded().catch(() => {});
    await para.click({ timeout: 8000 });
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+V");
    // 이미지가 올라와서 새 이미지 칸이 생길 때까지 기다린다 (최대 25초)
    for (let i = 0; i < 50; i++) {
      await page.waitForTimeout(500);
      if ((await f.evaluate(IMG_COUNT_JS)) > before - 0 && (await f.evaluate(IMG_COUNT_JS)) !== before) { pastedChapters.add(chapter); return { ok: true }; }
    }
    return { ok: false, reason: "붙여넣기를 했지만 이미지가 올라오지 않았어요. 글쓰기 창에서 Ctrl+V를 직접 눌러보세요." };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).split("\n")[0] };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { pasteImageAtChapter, MARK_JS, CIRCLED };
