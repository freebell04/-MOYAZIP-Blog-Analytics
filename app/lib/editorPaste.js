// 이미 열려 있는 네이버 글쓰기 창에서, 내 템플릿의 ꒰N꒱ 블록 맨 아래(그 블록의 마지막 글 아래)에 클립보드의 이미지를 붙여넣는다.
//  - 내 템플릿 모드(꒰①꒱~꒰⑥꒱ 블록이 있는 글)에서만 동작한다. 못 찾으면 아무것도 하지 않고 이유를 돌려준다.
//  - 이미지는 미리 윈도우 클립보드에 복사돼 있어야 한다 (imagePick.copyImageToClipboard).
const session = require("./session");

const pastedChapters = new Set(); // 이미 이미지를 붙여넣은 챕터 (다시 붙이면 앞의 것을 지우고 바꾼다)
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

// 에디터 프레임 안에서: 해당 번호의 블록을 찾아 "그 블록의 마지막 글 문단"에 표시(data-nbh-paste)를 단다.
// 블록 = ꒰N꒱ 글 컴포넌트 ~ 다음 구분선 직전. (설명 사이에 표가 들어 있으면 그 표 뒤의 마지막 글 문단)
// idx: 0부터 세는 챕터 번호. 내 템플릿 글이 아니면(꒰N꒱ 표시가 없으면) "N번째 섹션 소제목(세로선 인용구)" 블록을 쓴다.
const MARK_JS = (n, idx = 0) => `(() => {
  document.querySelectorAll("[data-nbh-paste],[data-nbh-img]").forEach((e) => { e.removeAttribute("data-nbh-paste"); e.removeAttribute("data-nbh-img"); });
  const comps = [...document.querySelectorAll(".se-component")];
  let mk = comps.findIndex((c) => [...c.querySelectorAll(".se-text-paragraph")].some((p) => p.textContent.replace(/\\u200b/g, "").trim() === ${JSON.stringify("꒰" + n + "꒱")}));
  let plain = false;
  if (mk < 0) {
    // 일반 글: 섹션 소제목은 세로선(quotation_line) 인용구. 맨 위 큰따옴표 인용구는 제외된다
    const heads = comps.map((c, i) => [c, i]).filter(([c]) => c.classList.contains("se-quotation") && (c.classList.contains("se-l-quotation_line") || c.querySelector(".se-l-quotation_line")));
    if (!heads.length || !heads[${idx}]) return "block-not-found";
    mk = heads[${idx}][1];
    plain = true;
  }
  let last = -1, imgIdx = -1;
  for (let i = mk; i < comps.length; i++) {
    if (i > mk && comps[i].classList.contains("se-horizontalLine")) break;
    if (plain && i > mk && comps[i].classList.contains("se-quotation") && (comps[i].classList.contains("se-l-quotation_line") || comps[i].querySelector(".se-l-quotation_line"))) break;
    if (i > mk && comps[i].classList.contains("se-image")) imgIdx = i; // 이 블록의 (마지막) 이미지 — 다시 넣을 때 바꿀 대상
    if (comps[i].classList.contains("se-text") || comps[i].querySelector(".se-text-paragraph")) {
      if (!comps[i].classList.contains("se-table") && !comps[i].classList.contains("se-quotation")) last = i;
    }
  }
  if (imgIdx >= 0) comps[imgIdx].setAttribute("data-nbh-img", "1");
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
    const isEd = (u) => /PostWriteForm|PostUpdateForm|postwrite/i.test(u);
    const page = context.pages().reverse().find((p) => p.frames().some((f) => isEd(f.url())));
    if (!page) return { ok: false, reason: "열려 있는 네이버 글쓰기 창을 찾지 못했어요." };
    const f = page.frames().find((x) => isEd(x.url()));
    const mark = await f.evaluate(MARK_JS(n, chapter));
    if (mark !== "ok") return { ok: false, reason: mark === "block-not-found" ? `글쓰기 창에서 ${chapter + 1}번째 섹션을 찾지 못했어요 (임시저장한 글을 연 창이 맞는지 확인해주세요).` : "그 블록의 글 칸을 찾지 못했어요." };
    // 이 챕터에 앞서 붙여넣은 이미지가 있으면 먼저 지운다 (다른 이미지로 바꿀 때) — 블록 맨 아래 글 칸 바로 다음 칸이 이미지일 때만
    // 이 챕터에 앞서 붙여넣은 이미지가 있으면 기억해 둔다: 새 이미지를 먼저 넣고, 들어온 걸 확인한 뒤에 예전 것을 지운다
    // (예전 것부터 지우면 그 자리의 글 칸이 같이 사라져서 붙여넣을 곳이 없어진다)
    let hadOld = false;
    if (pastedChapters.has(chapter)) {
      hadOld = await f.evaluate(() => {
        document.querySelectorAll("[data-nbh-old]").forEach((e) => e.removeAttribute("data-nbh-old"));
        const c = document.querySelector('[data-nbh-img="1"]');
        if (!c) return false;
        c.setAttribute("data-nbh-old", "1");
        return true;
      });
    }
    const before = await f.evaluate(IMG_COUNT_JS);
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(400);
    let clicked = false, lastMark = "";
    const clickEl = async (h) => {
      await h.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(200);
      const box = await h.boundingBox().catch(() => null);
      if (box && box.height > 0) {
        await page.mouse.click(box.x + Math.min(12, box.width / 2), box.y + Math.max(2, Math.min(box.height / 2, 14)));
        return true;
      }
      return await h.click({ timeout: 3000, force: true }).then(() => true).catch(() => false);
    };
    for (let attempt = 0; attempt < 5 && !clicked; attempt++) {
      // 에디터가 다시 그리면서 표시를 지우는 경우가 있어서, 표시를 달자마자 그 요소를 핸들로 잡아 누르고 안 되면 다시 단다
      const m = await f.evaluate(MARK_JS(n, chapter)).catch((e) => "err:" + String(e.message).slice(0, 60));
      lastMark = m;
      if (m !== "ok") { await page.waitForTimeout(600); continue; }
      const h = (await f.evaluateHandle(() => document.querySelector('[data-nbh-paste="1"]')).catch(() => null))?.asElement();
      if (!h) { lastMark = "no-handle"; await page.waitForTimeout(600); continue; }
      if (await clickEl(h)) { clicked = true; } else {
        lastMark = "no-box";
        if (process.env.NBH_DEBUG_PASTE) console.log("no-box detail:", JSON.stringify(await f.evaluate(() => { const e = document.querySelector('[data-nbh-paste="1"]'); if (!e) return "gone"; const r = e.getBoundingClientRect(); return { vis: document.visibilityState, conn: e.isConnected, rect: [r.x, r.y, r.width, r.height], inner: innerWidth + "x" + innerHeight, cls: e.className.slice(0, 60), parent: e.parentElement && e.parentElement.className.slice(0, 60) }; })));
        await page.waitForTimeout(600);
      }
    }
    if (!clicked) throw new Error("붙여넣을 자리를 찾지 못했어요. 글쓰기 창을 앞에 두고 다시 눌러주세요. [" + lastMark + "]");
    await page.keyboard.press("End");
    // 이미 빈 줄이면 줄을 또 만들지 않는다 (다시 넣을 때마다 빈 줄이 쌓이지 않게)
    const empty = await f.evaluate(() => { const p = document.querySelector('[data-nbh-paste="1"]'); return !!p && !p.textContent.replace(/​/g, "").trim(); });
    if (!empty) await page.keyboard.press("Enter");
    await page.keyboard.press("Control+V");
    // 이미지가 올라와서 새 이미지 칸이 생길 때까지 기다린다 (최대 25초)
    for (let i = 0; i < 50; i++) {
      await page.waitForTimeout(500);
      if ((await f.evaluate(IMG_COUNT_JS)) > before) {
        pastedChapters.add(chapter);
        let replaced = false;
        if (hadOld) {
          // 새 이미지가 들어온 걸 확인했으니 예전 이미지를 지운다 (선택 → Delete)
          await page.waitForTimeout(800);
          const old = (await f.evaluateHandle(() => document.querySelector('[data-nbh-old="1"]')).catch(() => null))?.asElement();
          if (old) {
            await old.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await clickEl(old);
            await page.keyboard.press("Delete");
            await page.waitForTimeout(700);
            replaced = (await f.evaluate(IMG_COUNT_JS)) === before;
          }
        }
        return { ok: true, replaced };
      }
    }
    return { ok: false, reason: "붙여넣기를 했지만 이미지가 올라오지 않았어요. 글쓰기 창에서 Ctrl+V를 직접 눌러보세요." };
  } catch (e) {
    return { ok: false, reason: String(e.message || e).split("\n")[0] };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { pasteImageAtChapter, MARK_JS, CIRCLED };
