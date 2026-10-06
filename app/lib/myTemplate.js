// "내 템플릿" 모드: 네이버 에디터의 "앞으로 쓸 템플릿"(INTRO / 목차 표 / ꒰①꒱~꒰⑥꒱ 본문 / 요약 표 / 소감)의 자리에
// AI가 쓴 글을 정확히 채워 넣는다. 이 모드는 사용자가 설정에서 켠 경우에만 쓰인다 (기본은 꺼짐).
//
// 글(tpl) 모양:
//  { title, intro, shortHeading, topicLine,
//    sections: [{ title, short, keyword, explain } × 6],
//    tocLines: [5개 — 목차 표 ①~⑤ 한 줄씩], summaryLines: [5개 — 요약 표 1~5 한 줄씩], reflection }
//
// 문단 번호(.se-text-paragraph 전체에서의 순서)로 자리를 정한다. 값을 바꾸는 작업이 문단 수를 늘릴 수 있어서(여러 줄 입력)
// 뒤쪽 문단부터 거꾸로 채운다 — 그러면 앞쪽 번호가 밀리지 않는다.

const BLOCKS = 6; // 템플릿의 본문 블록 수 (꒰①꒱~꒰⑥꒱)

const SEPARATOR = /^\|(\s*:?-{2,}:?\s*\|)+\s*$/;
/** 본문 글에서 "| a | b |" 마크다운 표를 떼어낸다 → {lines: [글줄 또는 null(표 자리)], tables: [[행[칸]]…]} */
function splitTables(text) {
  const src = String(text || "").split("\n");
  const lines = [];
  const tables = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i].trim().startsWith("|")) {
      const rows = [];
      while (i < src.length && src[i].trim().startsWith("|")) {
        if (!SEPARATOR.test(src[i].trim())) rows.push(src[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.replace(/\*\*/g, "").trim()));
        i++;
      }
      i--;
      lines.push(null);
      tables.push(rows);
    } else lines.push(src[i]);
  }
  return { lines, tables };
}

/**
 * paras: [{i, t, table, quote, title}] (현재 에디터의 문단 목록) → 실행할 작업 목록
 * 작업: {i, mode: "replace"|"suffix"|"append", old?, text}
 *   replace: 문단 전체를 text로 바꾼다 / suffix: 문단 끝의 old 글자를 text로 바꾼다 / append: 문단 끝에 text를 덧붙인다
 */
function planFill(paras, tpl) {
  return planFillFull(paras, tpl).ops;
}

/** planFill + 설명 칸에서 떼어낸 표들 ({ops, tables}). 표는 글이 다 채워진 뒤 자리표시 줄([[TABLE_n]]) 위치에 실제 표로 넣는다 */
function planFillFull(paras, tpl) {
  const ops = [];
  const tables = [];
  const secs = Array.isArray(tpl.sections) ? tpl.sections : [];
  const strip = (v) => String(v == null ? "" : v).replace(/\*\*/g, ""); // **굵게** 표시는 템플릿 자리에 글자로 남지 않게 뺀다
  const val = (v) => strip(v).replace(/\s+/g, " ").trim();
  const body = paras.filter((p) => !p.title);
  const find = (pred, from = 0) => body.findIndex((p, k) => k >= from && pred(p));

  // INTRO 블록: "INTRO" 아래 "제목" 한 줄 = 글 제목, "인트로 글" = 인트로
  const introAt = find((p) => p.t === "INTRO");
  if (introAt >= 0) {
    const tAt = find((p) => p.t === "제목", introAt);
    if (tAt >= 0 && tpl.title) ops.push({ i: body[tAt].i, mode: "replace", text: val(tpl.title) });
  }
  const introTextAt = find((p) => p.t === "인트로 글");
  if (introTextAt >= 0) ops.push({ i: body[introTextAt].i, mode: "replace", text: strip(tpl.intro).trim().replace(/[ \t]+/g, " ") });
  const shortAt = find((p) => p.t === "짧은 소제목");
  if (shortAt >= 0) ops.push({ i: body[shortAt].i, mode: "replace", text: val(tpl.shortHeading) });

  // 표 두 개: 첫 번째 = 목차 ("주제" 칸 + ①~⑤ "본문 내용"), 두 번째 = 요약 ("1."~"5.")
  const tableCells = body.filter((p) => p.table);
  const toc = tableCells.filter((p) => /^ε.{1,2}з 본문 내용$/.test(p.t));
  const tocHead = tableCells.find((p) => p.t === "주제");
  if (tocHead && tpl.topicLine) ops.push({ i: tocHead.i, mode: "replace", text: val(tpl.topicLine) });
  toc.forEach((p, k) => ops.push({ i: p.i, mode: "suffix", old: "본문 내용", text: val((tpl.tocLines || [])[k]) }));
  const sums = tableCells.filter((p) => /^[1-9]\.$/.test(p.t));
  sums.forEach((p, k) => {
    const line = val((tpl.summaryLines || [])[k]);
    if (line) ops.push({ i: p.i, mode: "append", text: " " + line });
  });

  // 본문 블록 ①~⑥: "본문 제목" / "짧은 본문" / 인용구 "N. 소제목" / "소제목에 대한 설명" 이 순서대로 반복된다
  const nth = (pred, k) => body.filter(pred)[k];
  for (let k = 0; k < BLOCKS; k++) {
    const s = secs[k] || {};
    const t = nth((p) => p.t === "본문 제목", k);
    if (t) ops.push({ i: t.i, mode: "replace", text: val(s.title) });
    const sh = nth((p) => p.t === "짧은 본문", k);
    if (sh) ops.push({ i: sh.i, mode: "replace", text: val(s.short) });
    const q = nth((p) => p.quote && /^\d\. 소제목$/.test(p.t), k);
    if (q) ops.push({ i: q.i, mode: "suffix", old: "소제목", text: val(s.keyword) });
    const ex = nth((p) => p.t === "소제목에 대한 설명", k);
    if (ex) {
      // 설명 속 마크다운 표는 자리표시 줄로 바꿔 두고, 표 자체는 따로 모았다가 나중에 넣는다 (문서 순서대로 번호를 매긴다)
      const sp = splitTables(strip(s.explain).trim());
      let n = 0;
      const withNumbers = sp.lines.map((l) => (l === null ? `[[TABLE_${tables.length + n++}]]` : l)).join("\n");
      sp.tables.forEach((t) => tables.push(t));
      ops.push({ i: ex.i, mode: "replace", text: withNumbers.trim() });
    }
  }

  const sg = find((p) => p.t === "소감");
  if (sg >= 0) ops.push({ i: body[sg].i, mode: "replace", text: strip(tpl.reflection).trim() });

  return { ops: ops.sort((a, b) => b.i - a.i), tables }; // 뒤쪽부터
}

/** 아직 채워지지 않고 남은 자리 이름들 (저장하기 전에 확인용) */
const PLACEHOLDERS = ["인트로 글", "짧은 소제목", "본문 제목", "짧은 본문", "소제목에 대한 설명"];
function leftover(paras) {
  return paras.filter((p) => !p.title && PLACEHOLDERS.includes(p.t)).map((p) => p.t);
}

const READ_PARAS = `[...document.querySelectorAll(".se-text-paragraph")].map((p, i) => ({
  i,
  t: p.textContent.replace(/\\u200b/g, "").trim(),
  table: !!p.closest(".se-table"),
  quote: !!p.closest(".se-quotation"),
  title: !!p.closest(".se-documentTitle"),
}))`;

/**
 * 에디터(frame: PostWriteForm 프레임)의 템플릿 자리를 채운다.
 * helpers: { replaceShortText, replaceWrappedText } (blogEditor의 입력 함수)
 */
async function fillMyTemplate(frame, page, tpl, helpers) {
  const f = page.frames().find((x) => x.url().includes("PostWriteForm")) || frame;
  const paras = await f.evaluate(READ_PARAS);
  const { ops, tables } = planFillFull(paras, tpl);
  if (!ops.length) throw new Error("내 템플릿의 자리를 찾지 못했어요. '앞으로 쓸 템플릿'이 맞는지 확인해주세요.");
  const all = f.locator(".se-text-paragraph");
  for (const op of ops) {
    const loc = all.nth(op.i);
    try {
      if (op.mode === "replace") {
        if (!op.text) { await loc.click({ timeout: 10000, clickCount: 3 }); await page.keyboard.press("Delete"); }
        else await helpers.replaceShortText(page, loc, op.text);
      } else if (op.mode === "suffix") {
        await helpers.replaceWrappedText(page, loc, op.old, op.text);
      } else if (op.mode === "append") {
        await loc.click({ timeout: 10000 });
        await page.keyboard.press("End");
        await page.keyboard.type(op.text, { delay: 10 });
      }
    } catch (e) {
      throw new Error(`템플릿 ${op.i}번째 자리를 채우지 못했어요: ${String(e.message).split("\n")[0]}`);
    }
    await page.waitForTimeout(120);
  }
  // 표: 자리표시 줄을 지우고 그 자리에 실제 표를 넣는다. 템플릿에 이미 표가 있어서(목차 표 1개) 문서 안에서는 그만큼 뒤 번호가 된다
  const TEMPLATE_TABLES_BEFORE = 1;
  if (tables.length && helpers.insertTable) {
    for (let k = 0; k < tables.length; k++) {
      try {
        await helpers.insertTable(f, page, k, tables[k], TEMPLATE_TABLES_BEFORE + k);
      } catch (e) {
        throw new Error(`표 ${k + 1}번째를 넣지 못했어요: ${String(e.message).split("\n")[0]}`);
      }
    }
  }
  const after = await f.evaluate(READ_PARAS);
  const left = leftover(after);
  if (left.length) throw new Error(`템플릿에서 채워지지 않은 자리가 있어요 (${[...new Set(left)].join(", ")}). 저장하지 않고 멈췄어요.`);
  return { filled: ops.length };
}

module.exports = { BLOCKS, splitTables, planFill, planFillFull, leftover, fillMyTemplate, READ_PARAS };

// ---------------------------------------------------------------------------
// 4단계: 이미 쓴 글(내 템플릿)에서 "본문 인용구(소제목)"를 읽어 목차 표와 요약 표를 채운다
// ---------------------------------------------------------------------------
const READ_QUOTES = `[...document.querySelectorAll(".se-quotation")].map((q) => { const p = q.querySelector(".se-text-paragraph"); return p ? p.textContent.replace(/\u200b/g, "").trim() : ""; }).filter(Boolean)`;
const HAS_TOC = `[...document.querySelectorAll(".se-table .se-text-paragraph")].some((p) => /본문 내용$/.test(p.textContent.replace(/\u200b/g, "").trim()))`;

/** 글 안의 인용구 소제목들 ("1. 소제목" 형태가 있으면 그것만, 앞의 번호는 뗀다) */
const headingsOf = (quotes) => {
  const numbered = quotes.filter((q) => /^\d+\.\s*\S/.test(q));
  return (numbered.length ? numbered : quotes).map((q) => q.replace(/^\d+\.\s*/, "").trim()).filter(Boolean);
};

/**
 * 목차 표: ①~⑤ 칸의 "본문 내용"을 각 본문 인용구 소제목으로 바꾼다.
 * 요약 표: 1~5 칸에 소제목을 바탕으로 쓴 한 줄 요약을 덧붙인다 (summarize(headings) → [5줄], 실패하면 소제목 그대로).
 */
async function fillTocFromQuotes(frame, page, helpers, summarize) {
  const f = page.frames().find((x) => x.url().includes("PostWriteForm")) || frame;
  const heads = headingsOf(await f.evaluate(READ_QUOTES));
  if (!heads.length) throw new Error("글에서 본문 인용구(소제목)를 찾지 못했어요. 인용구로 쓴 소제목이 있는 글인지 확인해주세요.");
  let sums = [];
  try { sums = (await summarize(heads)) || []; } catch {}
  const paras = await f.evaluate(READ_PARAS);
  const cells = paras.filter((p) => p.table);
  const toc = cells.filter((p) => /^ε.{1,2}з 본문 내용$/.test(p.t));
  const sumCells = cells.filter((p) => /^[1-9]\.$/.test(p.t));
  const ops = [];
  toc.forEach((p, k) => { if (heads[k]) ops.push({ i: p.i, mode: "suffix", old: "본문 내용", text: heads[k] }); });
  sumCells.forEach((p, k) => { const line = String(sums[k] || heads[k] || "").replace(/\s+/g, " ").trim(); if (line) ops.push({ i: p.i, mode: "append", text: " " + line }); });
  if (!ops.length) throw new Error("목차·요약 표의 자리를 찾지 못했어요 (내 템플릿 글인지 확인해주세요).");
  const all = f.locator(".se-text-paragraph");
  for (const op of ops.sort((a, b) => b.i - a.i)) {
    const loc = all.nth(op.i);
    if (op.mode === "suffix") await helpers.replaceWrappedText(page, loc, op.old, op.text);
    else { await loc.click({ timeout: 10000 }); await page.keyboard.press("End"); await page.keyboard.type(op.text, { delay: 10 }); }
    await page.waitForTimeout(120);
  }
  return { headings: heads, summaries: sums, filled: ops.length };
}

module.exports.fillTocFromQuotes = fillTocFromQuotes;
module.exports.HAS_TOC = HAS_TOC;
module.exports.headingsOf = headingsOf;
