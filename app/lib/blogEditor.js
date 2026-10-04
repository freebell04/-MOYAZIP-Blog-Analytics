// 네이버 블로그 스마트에디터원(SmartEditor ONE) 자동 입력 + 임시저장
// 주의: 네이버 에디터 DOM은 수시로 바뀔 수 있어, 아래 셀렉터는 최초 실행 시
// 실제로 동작하는지 확인 후 필요하면 조정해야 합니다.
const { openVisibleContext } = require("./session");

const BLOG_ID = require("./config").blogId();

const CONTENT_PLACEHOLDER = "내용을 입력하세요.";
const SECTION_MARKERS = ["꒰①꒱", "꒰②꒱", "꒰③꒱", "꒰④꒱", "꒰⑤꒱"];

/**
 * 짧은(줄바꿈 없이 한 줄로 보이는) 문단을 통째로 교체한다. 트리플클릭으로 문단 전체를
 * 선택한 뒤 타이핑하면 선택된 부분이 자동으로 지워지고 덮어써진다 — 제목/INTRO/섹션
 * placeholder처럼 원래 한 줄인 자리에서는 이 방식이 가장 안정적으로 확인됐다.
 */
async function replaceShortText(page, locator, newText) {
  await locator.click({ timeout: 10000, clickCount: 3 });
  const lines = newText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    await page.keyboard.type(lines[i], { delay: 10 });
    if (i < lines.length - 1) await page.keyboard.press("Enter");
  }
}

/**
 * 줄바꿈되어 여러 줄로 보이는 긴 문단(예: 전체요약의 "N. ~~~" 줄)을 교체한다.
 * 트리플클릭은 이런 문단에서 한 줄만 선택해버려서, 대신 문단을 클릭해 커서를 두고
 * End로 그 줄 끝까지 이동한 뒤 oldText의 글자 수만큼 정확히 Backspace로 지운다.
 * Backspace는 줄바꿈과 무관하게 논리적으로 앞 글자를 지우므로 여러 줄이어도 안전하다.
 */
async function replaceWrappedText(page, locator, oldText, newText) {
  await locator.click({ timeout: 10000 });
  await page.keyboard.press("End");

  const charCount = Array.from(oldText).length;
  for (let i = 0; i < charCount; i++) {
    await page.keyboard.press("Backspace");
  }

  const lines = newText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    await page.keyboard.type(lines[i], { delay: 10 });
    if (i < lines.length - 1) await page.keyboard.press("Enter");
  }
}

/**
 * 1단계: 본문만 채운다 (INTRO 3줄 + 섹션 5개의 소제목/내용).
 * 목차·전체요약 표는 건드리지 않는다 — 그건 사용자가 본문을 직접 다듬은 뒤
 * 별도로 fillTocAndSummary()를 호출해서 채운다.
 */
async function fillBodyOnly(frame, page, post) {
  // INTRO 3줄: "INTRO" 제목과 "© 2026" 저작권 줄 사이에 있는 문단들의 현재 텍스트를 읽어와서,
  // 그 정확한 현재 텍스트로 각각을 찾아 교체한다 (템플릿 내용이 바뀌어도 위치 기반으로 동작).
  const currentIntroLines = await frame.locator(":root").evaluate(() => {
    const paras = Array.from(document.querySelectorAll(".se-text-paragraph"));
    const textOf = (el) => el.textContent.trim();
    const introIdx = paras.findIndex((p) => textOf(p) === "INTRO");
    const copyrightIdx = paras.findIndex((p) => textOf(p).startsWith("© "));
    if (introIdx === -1 || copyrightIdx === -1 || copyrightIdx <= introIdx) return [];
    return paras
      .slice(introIdx + 1, copyrightIdx)
      .map(textOf)
      .filter(Boolean);
  });

  for (let i = 0; i < Math.min(currentIntroLines.length, post.introLines.length); i++) {
    const loc = frame.locator(`:text-is("${escapeQuotes(currentIntroLines[i])}")`).first();
    try {
      await replaceShortText(page, loc, post.introLines[i]);
    } catch {
      continue;
    }
  }

  // 섹션 소제목 블록: 각 ꒰N꒱ 마커 뒤, placeholder(또는 5번은 "요약") 전까지의 줄들을
  // 새 소제목으로 교체한다. 이 탐색은 placeholder 텍스트("내용을 입력하세요.")를 경계로 삼으므로
  // *반드시* 아래 "섹션 본문" 교체보다 먼저 해야 한다 — 본문을 먼저 채우면 그 경계 텍스트 자체가
  // 사라져서 못 찾는다(실제로 이 순서가 뒤바뀌어서 소제목이 하나도 안 채워지는 버그가 있었음).
  // 각 줄을 새 내용으로 교체한다. 섹션끼리 완전히 똑같은 문구(예: "토큰 소비율"이 ①②에
  // 둘 다 있음)가 있어서 텍스트로 찾으면 서로 엉키므로, 전체 문단 목록에서의 절대 위치(인덱스)로
  // 정확히 지정한다 — 이 교체들은 문단 개수를 바꾸지 않으므로(한 줄 -> 한 줄) 인덱스가 안 밀린다.
  if (post.sectionHeadingLines && post.sectionHeadingLines.length) {
    const groupIndexes = await frame.locator(":root").evaluate(
      (root, { markers, placeholder }) => {
        const paras = Array.from(document.querySelectorAll(".se-text-paragraph"));
        const textOf = (el) => el.textContent.trim();
        const texts = paras.map(textOf);
        return markers.map((marker, m) => {
          const startIdx = texts.findIndex((t) => t === marker);
          if (startIdx === -1) return [];
          const boundary = m === markers.length - 1 ? "요약" : placeholder;
          let endIdx = -1;
          for (let i = startIdx + 1; i < texts.length; i++) {
            if (texts[i] === boundary) {
              endIdx = i;
              break;
            }
          }
          if (endIdx === -1) return [];
          const idxs = [];
          for (let i = startIdx + 1; i < endIdx; i++) {
            if (texts[i]) idxs.push(i);
          }
          return idxs;
        });
      },
      { markers: SECTION_MARKERS, placeholder: CONTENT_PLACEHOLDER }
    );

    const allParas = frame.locator(".se-text-paragraph");
    for (let s = 0; s < Math.min(groupIndexes.length, post.sectionHeadingLines.length); s++) {
      const idxs = groupIndexes[s];
      const newLines = post.sectionHeadingLines[s] || [];
      for (let li = 0; li < idxs.length; li++) {
        const newText = newLines[li] !== undefined ? newLines[li] : "";
        try {
          await replaceShortText(page, allParas.nth(idxs[li]), newText);
        } catch {
          continue;
        }
      }
    }
  }

  // 섹션 본문 placeholder("내용을 입력하세요.")는 5개가 동일한 텍스트로 반복되므로 nth()로 찾아 교체한다.
  // 앞에서부터 교체하면 그 즉시 매칭에서 빠지면서 나머지의 nth 인덱스가 앞으로 밀리므로, 뒤에서부터 교체한다.
  const placeholderLoc = frame.locator(`:text-is("${CONTENT_PLACEHOLDER}")`);
  const count = await placeholderLoc.count();
  const n = Math.min(count, post.sections.length);
  for (let i = n - 1; i >= 0; i--) {
    const loc = placeholderLoc.nth(i);
    try {
      await replaceShortText(page, loc, post.sections[i]);
    } catch {
      continue;
    }
    await page.waitForTimeout(200);
  }
}

/**
 * 현재 문서에서 각 섹션(꒰①꒱~꒰⑤꒱)의 소제목 첫 줄과, ①~④의 본문 내용을 읽어온다.
 * 2단계(목차+전체요약 채우기)에서, 사용자가 직접 수정했을 수도 있는 "지금 실제 내용"을
 * 기준으로 삼기 위해 사용한다.
 */
async function readCurrentSections(frame) {
  return frame.locator(":root").evaluate(
    ({ markers, placeholder }) => {
      const paras = Array.from(document.querySelectorAll(".se-text-paragraph"));
      const textOf = (el) => el.textContent.trim();
      const texts = paras.map(textOf);
      return markers.map((marker, m) => {
        const startIdx = texts.findIndex((t) => t === marker);
        if (startIdx === -1) return { heading: "", body: "" };
        const boundary = m === markers.length - 1 ? "요약" : placeholder;
        let boundaryIdx = -1;
        for (let i = startIdx + 1; i < texts.length; i++) {
          if (texts[i] === boundary) {
            boundaryIdx = i;
            break;
          }
        }
        if (boundaryIdx === -1) return { heading: "", body: "" };
        const headingLines = texts.slice(startIdx + 1, boundaryIdx).filter(Boolean);
        // 마지막 섹션(5번)은 placeholder가 없어서 heading 다음이 바로 본문이 아니라 "요약"이므로 body는 빈 값
        let body = "";
        if (m < markers.length - 1) {
          // placeholder 다음 줄이 실제 입력된 본문
          body = texts[boundaryIdx + 1] || "";
        }
        return { heading: headingLines[0] || "", body };
      });
    },
    { markers: SECTION_MARKERS, placeholder: CONTENT_PLACEHOLDER }
  );
}

/**
 * 2단계: 목차 5줄 + 목차/요약 부제목 + 전체요약 5줄을 채운다.
 * 목차는 "지금 문서에 실제로 적힌" 섹션 소제목을 그대로 가져와서 반영하고
 * (사용자가 손으로 고쳤을 수도 있으므로), 부제목/요약 문구는 미리 계산해서 넘겨받은
 * post.tocSummary / post.recapLines를 사용한다.
 */
async function fillTocAndSummary(frame, page, post) {
  const currentTocLines = await frame.locator(":root").evaluate(() => {
    const paras = Array.from(document.querySelectorAll(".se-text-paragraph"));
    const textOf = (el) => el.textContent.trim();
    const tocIdx = paras.findIndex((p) => textOf(p) === "목차 입니다.");
    if (tocIdx === -1) return [];
    const numbered = [];
    for (let i = tocIdx + 1; i < paras.length; i++) {
      const t = textOf(paras[i]);
      if (/^\d+\.\s/.test(t)) numbered.push(t);
      else if (numbered.length > 0) break;
    }
    return numbered;
  });

  for (let i = 0; i < Math.min(currentTocLines.length, post.sectionHeadings.length); i++) {
    const loc = frame.locator(`:text-is("${escapeQuotes(currentTocLines[i])}")`).first();
    try {
      await replaceShortText(page, loc, `${i + 1}. ${post.sectionHeadings[i]}`);
    } catch {
      continue;
    }
  }

  if (post.tocSummary) {
    // 같은 문구가 목차 블록과 요약 블록에 각각 한 번씩 나온다.
    // 문서 순서상 목차가 먼저이므로 nth(0)=목차 부제목, nth(1)=요약 부제목.
    const currentSubtitle = await frame.locator(":root").evaluate(() => {
      const paras = Array.from(document.querySelectorAll(".se-text-paragraph"));
      const textOf = (el) => el.textContent.trim();
      const tocIdx = paras.findIndex((p) => textOf(p) === "목차 입니다.");
      if (tocIdx === -1) return null;
      const guideIdx = tocIdx + 1;
      const subtitleIdx = guideIdx + 1;
      return paras[subtitleIdx] ? textOf(paras[subtitleIdx]) : null;
    });

    if (currentSubtitle) {
      const subtitleLoc = frame.locator(`:text-is("${escapeQuotes(currentSubtitle)}")`);
      const subtitleCount = await subtitleLoc.count();
      for (let i = subtitleCount - 1; i >= 0; i--) {
        try {
          await replaceShortText(page, subtitleLoc.nth(i), post.tocSummary);
        } catch {
          continue;
        }
      }
    }
  }

  // 요약(recap) 줄: "요약" 소제목 뒤에 "N. ~~~" 형식으로 이어지는 줄들을 교체.
  const currentRecapLines = await frame.locator(":root").evaluate(() => {
    const paras = Array.from(document.querySelectorAll(".se-text-paragraph"));
    const textOf = (el) => el.textContent.trim();
    const summaryIdx = paras.findIndex((p) => textOf(p) === "요약");
    if (summaryIdx === -1) return [];
    const numbered = [];
    for (let i = summaryIdx + 1; i < paras.length; i++) {
      const t = textOf(paras[i]);
      if (/^\d+\.\s/.test(t)) numbered.push(t);
      else if (numbered.length > 0) break;
    }
    return numbered;
  });

  for (let i = 0; i < Math.min(currentRecapLines.length, post.recapLines.length); i++) {
    const loc = frame.locator(`:text-is("${escapeQuotes(currentRecapLines[i])}")`).first();
    try {
      await replaceWrappedText(page, loc, currentRecapLines[i], `${i + 1}. ${post.recapLines[i]}`);
    } catch {
      continue;
    }
  }
}

function escapeQuotes(text) {
  return text.replace(/"/g, '\\"');
}

/**
 * 템플릿 없이 쓸 때, introLines/sectionHeadingLines/sections를 자연스러운
 * 한 편의 글로 이어붙인다 (소제목 + 본문 문단을 순서대로).
 */
function composePlainBody(post) {
  const parts = [];
  if (post.introLines && post.introLines.length) {
    parts.push(post.introLines.join("\n")); // 도입 줄은 줄마다 따로
  }
  const sections = post.sections || [];
  const headings = post.sectionHeadingLines || [];
  for (let i = 0; i < sections.length; i++) {
    const heading = (headings[i] || []).join("\n"); // 소제목 여러 줄도 줄마다 따로
    if (heading) parts.push(heading);
    parts.push(sections[i]);
  }
  return parts.join("\n\n");
}

/**
 * 커서 위치에 글자를 넣는다. keyboard.type은 줄 맨 앞 "1. "을 자동 번호목록으로 바꿔버리고,
 * insertText는 이모지가 섞인 문자열을 통째로 넣으면 이모지만 남기고 나머지를 날려버린다.
 * 그래서 insertText를 쓰되 이모지와 일반 글자를 조각으로 나눠서 넣는다.
 */
async function typeText(page, text) {
  const parts = text.split(/(\p{Extended_Pictographic}\uFE0F?)/u).filter(Boolean);
  for (const part of parts) {
    await page.keyboard.insertText(part);
    // 에디터가 이모지를 따로 처리하는 동안 바로 다음 입력을 넣으면 앞뒤 입력이 씹혀서 사라진다.
    const isEmoji = /\p{Extended_Pictographic}/u.test(part);
    await page.waitForTimeout(isEmoji ? 150 : 20);
  }
}

const TABLE_SEPARATOR_ROW = /^\|(\s*:?-{2,}:?\s*\|)+\s*$/;

function parseTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** 본문을 "일반 줄"과 "| a | b |" 마크다운 표로 나눈다. 표 자리는 lines에 null로 남긴다. */
function parseBody(bodyText) {
  const src = bodyText.split("\n");
  const lines = [];
  const tables = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i].trim().startsWith("|")) {
      const rows = [];
      while (i < src.length && src[i].trim().startsWith("|")) {
        if (!TABLE_SEPARATOR_ROW.test(src[i].trim())) rows.push(parseTableRow(src[i]));
        i++;
      }
      i--;
      lines.push(null);
      tables.push(rows);
    } else {
      lines.push(src[i]);
    }
  }
  return { lines, tables };
}

/**
 * 본문 텍스트를 줄 단위로 입력하되, 마크다운 표는 네이버 표로 바꿔 넣는다.
 * 표를 입력 도중에 바로 넣으면 표 뒤로 커서를 옮기기가 어려워서, 먼저 표 자리에 자리표시 줄을
 * 넣어가며 글 전체를 쓰고, 마지막에 자리표시 줄을 하나씩 실제 표로 바꾼다
 * (자리표시 줄에서 표 추가를 누르면 그 위치에 표가 들어가는 것을 확인함).
 */
/**
 * 템플릿 없이 쓸 때 "깔끔한 기본 틀"로 쓰기 위한 블록 목록.
 *   도입(introLines) → 따옴표 인용구 / 섹션 소제목 → 세로선 인용구(굵게) / 섹션 사이 → 구분선
 *   본문 줄의 **굵게** 표시는 굵게, "- " 로 시작하는 줄은 "• " 목록 줄로 쓴다.
 */
function composeStyledBlocks(post) {
  const blocks = [];
  const intro = (post.introLines || []).map((l) => l.trim()).filter(Boolean);
  if (intro.length) blocks.push({ type: "quote", style: "default", lines: intro, bold: false });
  const sections = post.sections || [];
  const headings = post.sectionHeadingLines || [];
  sections.forEach((body, i) => {
    if (i > 0 || intro.length) blocks.push({ type: "hr" });
    const heading = (headings[i] || []).map((l) => l.trim()).filter(Boolean).join(" ");
    if (heading) blocks.push({ type: "quote", style: "quotation_line", lines: [heading], bold: true, chapter: i });
    for (const raw of String(body || "").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      blocks.push({ type: "para", text: /^[-*•]\s+/.test(line) ? "• " + line.replace(/^[-*•]\s+/, "") : line });
    }
  });
  return blocks;
}

/** "**굵게**" 표시를 풀어서 [{text, bold}] 조각으로 */
function boldSegments(text) {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter(Boolean)
    .map((s) => (/^\*\*[^*]+\*\*$/.test(s) ? { text: s.slice(2, -2), bold: true } : { text: s, bold: false }));
}

async function typeWithBold(page, text) {
  for (const seg of boldSegments(text)) {
    if (seg.bold) await page.keyboard.press("Control+b");
    await typeText(page, seg.text);
    if (seg.bold) await page.keyboard.press("Control+b");
  }
}

/**
 * 스마트에디터의 인용구·구분선을 써서 블록을 차례로 입력한다.
 * 인용구는 아래에 빈 줄이 없으면 빠져나올 수 없어서(↓가 '출처' 칸에서 멈춤),
 * 넣기 전에 아래 빈 줄을 먼저 만들어두고 ↓↓ 로 그 줄로 내려온다.
 */
async function writeStyledBody(frame, page, blocks) {
  const f = page.frames().find((x) => x.url().includes("PostWriteForm")) || frame;
  for (const b of blocks) {
    if (b.type === "para") {
      await typeWithBold(page, b.text);
      await page.keyboard.press("Enter");
    } else if (b.type === "hr") {
      await f.click("button.se-insert-horizontal-line-default-toolbar-button");
      await page.waitForTimeout(500); // 구분선 뒤에 빈 줄이 자동으로 생기고 커서가 그리로 간다
    } else if (b.type === "quote") {
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowUp");
      if (b.style === "default") {
        await f.click("button.se-insert-quotation-default-toolbar-button");
      } else {
        await f.click("button.se-document-toolbar-select-option-button[data-name='quotation']");
        await page.waitForTimeout(400);
        await f.click(`button[data-value='${b.style}']`);
      }
      await page.waitForTimeout(600);
      for (let i = 0; i < b.lines.length; i++) {
        if (i > 0) await page.keyboard.press("Enter");
        if (b.bold) await page.keyboard.press("Control+b");
        await typeWithBold(page, b.lines[i]);
        if (b.bold) await page.keyboard.press("Control+b");
      }
      await page.keyboard.press("ArrowDown"); // 출처 칸
      await page.keyboard.press("ArrowDown"); // 미리 만들어둔 아래 빈 줄
      await page.waitForTimeout(300);
    }
  }
}

/**
 * 챕터별 이미지를 각 소제목(인용구) 바로 아래에 올린다.
 * 소제목 다음 본문 첫 줄의 맨 앞에 커서를 두고 툴바 '사진' → 파일 올리기를 하면, 그 줄 위(= 소제목 바로 아래)에 사진이 들어간다.
 * 하나가 실패해도 글은 그대로 두고 다음 이미지로 넘어가며, 챕터마다 결과를 돌려준다.
 *   state: "ok"(소제목 바로 아래 확인됨) | "placed"(올라갔지만 자리는 확인 못 함) | "failed"(못 올림)
 * @param {{chapter:number, quoteIndex:number, path:string}[]} jobs  quoteIndex = 에디터 안 인용구 순서(소개 인용구 포함)
 */
async function insertChapterImages(frame, page, jobs) {
  const f = page.frames().find((x) => x.url().includes("PostWriteForm")) || frame;
  const results = [];
  for (const job of jobs) {
    const r = { chapter: job.chapter, state: "failed", reason: "" };
    results.push(r);
    try {
      const before = await f.evaluate(() => document.querySelectorAll(".se-component.se-image").length);
      // 이 소제목 인용구 다음 컴포넌트(본문 첫 줄)의 맨 앞을 클릭해 커서를 둔다
      const target = await f.evaluateHandle((qi) => {
        const quotes = [...document.querySelectorAll(".se-component.se-quotation")];
        const q = quotes[qi];
        if (!q) return null;
        let next = q.nextElementSibling;
        while (next && !next.querySelector(".se-text-paragraph")) next = next.nextElementSibling;
        return next ? next.querySelector(".se-text-paragraph") : null;
      }, job.quoteIndex);
      const el = target.asElement();
      if (!el) { r.reason = "소제목 아래 본문 줄을 못 찾았어요"; continue; }
      await el.scrollIntoViewIfNeeded();
      await el.click({ position: { x: 2, y: 2 }, timeout: 8000 });
      await page.keyboard.press("Home"); // 그 줄의 맨 앞
      await page.waitForTimeout(250);
      const photoBtn = f.locator("button[data-name='image'], .se-image-toolbar-button").first();
      if (!(await photoBtn.isVisible().catch(() => false))) { r.reason = "툴바의 사진 버튼을 못 찾았어요"; continue; }
      const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 10000 }).catch(() => null), photoBtn.click()]);
      if (!chooser) { r.reason = "사진 올리기 창이 안 열렸어요"; continue; }
      await chooser.setFiles(job.path);
      await page.waitForTimeout(2500); // 업로드가 끝나 사진이 자리 잡을 때까지
      const after = await f.evaluate((qi) => {
        const imgs = document.querySelectorAll(".se-component.se-image").length;
        const q = [...document.querySelectorAll(".se-component.se-quotation")][qi];
        let under = false;
        if (q) {
          let n = q.nextElementSibling;
          // 소제목 바로 다음(빈 텍스트 줄은 건너뜀)에 사진이 있으면 제자리
          while (n && n.classList.contains("se-text") && !n.innerText.replace(/\u200b/g, "").trim()) n = n.nextElementSibling;
          under = !!(n && n.classList.contains("se-image"));
        }
        return { imgs, under };
      }, job.quoteIndex);
      if (after.imgs > before) {
        r.state = after.under ? "ok" : "placed";
        if (!after.under) r.reason = "사진은 올라갔는데 소제목 바로 아래인지 확인하지 못했어요";
      } else {
        r.reason = "사진이 올라간 걸 확인하지 못했어요";
      }
      await page.keyboard.press("Escape").catch(() => {});
    } catch (e) {
      r.reason = String(e.message || e).split("\n")[0].slice(0, 120);
    }
  }
  return results;
}

/** 입력 결과가 블록과 맞는지 확인 (인용구 개수·소제목·본문 줄) */
async function verifyStyledBody(frame, page, blocks) {
  const f = page.frames().find((x) => x.url().includes("PostWriteForm")) || frame;
  const actual = await f.evaluate(() => {
    const clean = (s) => s.replace(/​/g, "").replace(/\s+/g, " ").trim();
    const comps = [...document.querySelectorAll(".se-component")].filter((c) => !c.classList.contains("se-documentTitle"));
    return {
      quotes: comps.filter((c) => c.classList.contains("se-quotation")).map((c) => clean((c.querySelector(".se-quote") || c).innerText)),
      hrs: comps.filter((c) => c.classList.contains("se-horizontalLine")).length,
      text: clean(comps.filter((c) => c.classList.contains("se-text")).map((c) => c.innerText).join(" ")),
    };
  });
  const quotes = blocks.filter((b) => b.type === "quote");
  const hrs = blocks.filter((b) => b.type === "hr").length;
  if (actual.quotes.length !== quotes.length) return { ok: false, reason: `인용구 개수가 다름: 원문 ${quotes.length} / 에디터 ${actual.quotes.length}` };
  if (actual.hrs !== hrs) return { ok: false, reason: `구분선 개수가 다름: 원문 ${hrs} / 에디터 ${actual.hrs}` };
  const plain = (s) => s.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  for (let i = 0; i < quotes.length; i++) {
    const want = plain(quotes[i].lines.join(" "));
    if (!actual.quotes[i].includes(want)) return { ok: false, reason: `${i + 1}번째 인용구가 다름: 원문 "${want}" / 에디터 "${actual.quotes[i]}"` };
  }
  for (const p of blocks.filter((b) => b.type === "para")) {
    if (!actual.text.includes(plain(p.text))) return { ok: false, reason: `본문 줄이 빠짐: "${plain(p.text).slice(0, 30)}"` };
  }
  return { ok: true };
}

async function writePlainBody(frame, page, bodyText) {
  const { lines, tables } = parseBody(bodyText);
  let tableNo = 0;
  for (const line of lines) {
    await typeText(page, line === null ? `[[TABLE_${tableNo++}]]` : line);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(40);
  }
  for (let t = 0; t < tables.length; t++) {
    await insertTableAtPlaceholder(frame, page, t, tables[t]);
  }
}

/**
 * 에디터에 실제로 들어간 본문이 원문과 같은지 줄/표 단위로 대조한다.
 * 드물게 입력 도중 여러 줄이 통째로 사라지는 경우가 있어서, 저장 전에 반드시 확인한다.
 */
async function verifyPlainBody(frame, bodyText) {
  const { lines, tables } = parseBody(bodyText);
  const expectedLines = lines.filter((l) => l !== null).map((l) => l.trim());
  const actual = await frame.locator(":root").evaluate(() => {
    const clean = (el) => el.textContent.replace(/\u200b/g, "").trim();
    return {
      lines: Array.from(document.querySelectorAll(".se-text-paragraph"))
        .filter((p) => !p.closest(".se-documentTitle, .se-table"))
        .map(clean),
      tables: Array.from(document.querySelectorAll(".se-component.se-table table")).map((t) =>
        Array.from(t.rows).map((r) => Array.from(r.cells).map(clean))
      ),
    };
  });
  while (actual.lines.length && actual.lines[actual.lines.length - 1] === "") actual.lines.pop();
  while (expectedLines.length && expectedLines[expectedLines.length - 1] === "") expectedLines.pop();

  for (let i = 0; i < Math.max(expectedLines.length, actual.lines.length); i++) {
    if (expectedLines[i] !== actual.lines[i]) {
      return { ok: false, reason: `${i + 1}번째 줄이 다름: 원문 "${expectedLines[i] || ""}" / 에디터 "${actual.lines[i] || ""}"` };
    }
  }
  if (tables.length !== actual.tables.length) {
    return { ok: false, reason: `표 개수가 다름: 원문 ${tables.length}개 / 에디터 ${actual.tables.length}개` };
  }
  for (let t = 0; t < tables.length; t++) {
    if (JSON.stringify(tables[t]) !== JSON.stringify(actual.tables[t])) {
      return { ok: false, reason: `${t + 1}번째 표 내용이 다름` };
    }
  }
  return { ok: true };
}

async function insertTableAtPlaceholder(frame, page, tableIndex, rows) {
  const rowCount = rows.length;
  const colCount = Math.max(...rows.map((r) => r.length));

  const placeholder = frame
    .locator(".se-text-paragraph")
    .filter({ hasText: new RegExp(`^\\[\\[TABLE_${tableIndex}\\]\\]$`) })
    .first();
  await placeholder.click({ clickCount: 3, timeout: 15000 });
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  await frame.locator(".se-table-toolbar-button").first().click();
  await page.waitForTimeout(1200);

  // 표는 문서 순서대로 하나씩 만들기 때문에, 방금 넣은 표는 tableIndex번째 표다.
  // 행/열 추가 버튼은 표 안에 있지만, 누를 때마다 다시 그려져서 곧바로 다음 버튼을 누르면
  // 클릭이 씹힌다. 그래서 버튼 이름 대신 "실제 행/열 개수가 바뀌었는지"를 확인하며 한 번씩 누른다.
  // (다른 표의 버튼을 잘못 누르면 에디터 전체가 멈추므로 절대 표 밖에서 버튼을 찾지 않는다.)
  const table = frame.locator(".se-component.se-table").nth(tableIndex);
  const size = () =>
    table.locator("table").evaluate((t) => ({ rows: t.rows.length, cols: t.rows[0] ? t.rows[0].cells.length : 0 }));

  const clickUntil = async (getButton, done, what) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const btn = await getButton();
      if (btn) await btn.evaluate((el) => el.click()).catch(() => {});
      for (let w = 0; w < 10; w++) {
        await page.waitForTimeout(200);
        if (done(await size())) return;
      }
    }
    throw new Error(`표 ${tableIndex + 1}: ${what} 실패`);
  };
  const lastInTable = async (cls, textPart) => {
    const loc = table.locator(cls).filter({ hasText: textPart });
    const n = await loc.count();
    return n ? loc.nth(n - 1) : null;
  };
  const deleteSelected = async () => {
    const del = table.locator(".se-cell-context-menu-button.se-context-menu-button-delete").first();
    if (await del.count()) await del.evaluate((el) => el.click()).catch(() => {});
  };

  // 기본으로 3x3 표가 들어간다. 행/열을 필요한 만큼 맞춘다.
  while ((await size()).rows < rowCount) {
    const before = (await size()).rows;
    await clickUntil(() => lastInTable(".se-cell-add-button", "행 다음에 행 추가"), (s) => s.rows > before, "행 추가");
  }
  while ((await size()).cols < colCount) {
    const before = (await size()).cols;
    await clickUntil(() => lastInTable(".se-cell-add-button", "열 다음에 열 추가"), (s) => s.cols > before, "열 추가");
  }
  while ((await size()).cols > colCount) {
    const before = (await size()).cols;
    await clickUntil(
      async () => {
        const sel = await lastInTable(".se-cell-select-button", "열 선택");
        if (sel) await sel.evaluate((el) => el.click()).catch(() => {});
        await page.waitForTimeout(300);
        await deleteSelected();
        return null;
      },
      (s) => s.cols < before,
      "열 삭제"
    );
  }
  while ((await size()).rows > rowCount) {
    const before = (await size()).rows;
    await clickUntil(
      async () => {
        const sel = await lastInTable(".se-cell-select-button", "행 선택");
        if (sel) await sel.evaluate((el) => el.click()).catch(() => {});
        await page.waitForTimeout(300);
        await deleteSelected();
        return null;
      },
      (s) => s.rows < before,
      "행 삭제"
    );
  }

  // Tab으로는 다음 칸으로 안 넘어가서(같은 칸에 이어 붙음) 칸을 하나씩 클릭해서 채운다.
  const cells = table.locator("td .se-text-paragraph");
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < colCount; c++) {
      const text = rows[r][c] || "";
      if (!text) continue;
      await cells.nth(r * colCount + c).click({ timeout: 10000 });
      if (r === 0) await page.keyboard.press("Control+b");
      await typeText(page, text);
      if (r === 0) await page.keyboard.press("Control+b");
    }
  }
  await page.waitForTimeout(300);
}

/**
 * @param {{title: string, bodyHtml: string, imagePaths: string[]}} post
 */
async function saveDraftToNaver(post) {
  if (!BLOG_ID) throw new Error("환경변수 NAVER_BLOG_ID가 설정되어 있지 않습니다.");

  // 로그인 때와 같은(눈에 보이는) 디버그 크롬을 그대로 사용 — 사용자가 과정을 볼 수 있게
  const { browser, context } = await openVisibleContext();
  const page = await context.newPage();
  await page.bringToFront().catch(() => {});
  require("./session").notifyChrome("블로그 글쓰기 창");

  try {
    // 직접 글쓰기 URL로 바로 가지 않고, 블로그 홈 → '글쓰기' 버튼 클릭 순서로 진입.
    // 블로그 홈 콘텐츠 자체가 #mainFrame iframe 안에 있고, '글쓰기' 링크도 그 안에 있다.
    await page.goto(`https://blog.naver.com/${BLOG_ID}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.bringToFront().catch(() => {});

    let frame = page.frameLocator("#mainFrame");
    // "글쓰기"라는 텍스트를 포함하는 링크가 여러 개 있어서(댓글쓰기, ~팁 등),
    // 실제 글쓰기 페이지로 가는 링크(href에 postwrite 또는 Redirect=Write 포함)만 정확히 골라 클릭.
    // 글쓰기 링크가 상단 네비게이션 드롭다운 안에 있어 평소엔 display:none 상태라
    // Playwright의 일반 클릭(가시성 요구)으로는 안 눌린다. DOM에서 직접 클릭 이벤트를 발생시킨다.
    const writeBtn = frame.locator("a[href*='postwrite'], a[href*='Redirect=Write']").first();
    await writeBtn.waitFor({ state: "attached", timeout: 15000 });
    await writeBtn.evaluate((el) => el.click());
    await page.waitForTimeout(2000);

    frame = page.frameLocator("#mainFrame");

    // "작성 중인 글이 있습니다" 팝업 처리.
    // continueDraft면 '확인'을 눌러 임시저장된 그 글을 이어서 열고(같은 글을 계속 고칠 때),
    // 아니면 '취소'로 새 글을 시작한다.
    const continueDraft = post.continueDraft === true;
    const popupBtn = continueDraft
      ? frame.locator(".se-popup-alert-confirm .se-popup-button-confirm").first()
      : frame.locator(".se-popup-alert-confirm .se-popup-button-cancel").first();
    if (await popupBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await popupBtn.click();
      await page.waitForTimeout(continueDraft ? 1500 : 500);
    }

    // 신규 에디터에 뜨는 '도움말' 튜토리얼 패널이 이후 버튼 클릭을 가로막아서 먼저 닫는다
    // (이 패널은 #mainFrame 밖, 최상위 페이지에 떠 있음)
    await page.evaluate(() => {
      const helpTitle = Array.from(document.querySelectorAll("*")).find(
        (el) => el.children.length === 0 && el.textContent.trim() === "도움말"
      );
      const panel = helpTitle && (helpTitle.closest("[class*='help'], [class*='Help']") || helpTitle.parentElement);
      const closeBtn = panel && panel.querySelector("button, [role='button']");
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
    await page.waitForTimeout(300);

    const useTemplate = post.useTemplate !== false;

    // 안전장치: 새 글로 시작했는데 본문에 이미 내용이 있으면(이어쓰기 팝업을 놓쳐 기존 임시저장 글이 열린 경우 등)
    // 아래에서 본문을 전부 지우고 새로 쓰게 되므로, 기존 글을 덮어쓰지 않도록 여기서 멈춘다.
    if (!continueDraft && !useTemplate) {
      const existing = await page
        .frames()
        .find((x) => x.url().includes("PostWriteForm"))
        ?.evaluate(() =>
          [...document.querySelectorAll(".se-component:not(.se-documentTitle)")]
            .map((c) => (c.querySelector(".se-placeholder") ? "" : c.innerText))
            .join("")
            .replace(/\s|​/g, "")
            .replace("글감과함께나의일상을기록해보세요!", "")
        )
        .catch(() => "");
      if (existing && existing.length > 0) {
        throw new Error("새 글 화면에 이미 다른 글 내용이 열려 있어서, 덮어쓰지 않도록 멈췄어요. 크롬의 글쓰기 탭을 닫고 다시 시도해주세요.");
      }
    }

    if (useTemplate) {
      // 템플릿 → 내 템플릿 → '앞으로 쓸 템플릿' 클릭 (내용은 그대로 두고, 덮어쓰기 확인만 처리)
      const tmplBtn = frame.locator(".se-template-toolbar-button").first();
      await tmplBtn.evaluate((el) => el.click());
      await page.waitForTimeout(1000);

      const myTmplTab = frame.getByText("내 템플릿", { exact: true }).first();
      await myTmplTab.evaluate((el) => el.click());
      await page.waitForTimeout(800);

      const targetTmpl = frame.getByText("앞으로 쓸 템플릿", { exact: true }).first();
      await targetTmpl.evaluate((el) => el.click());
      await page.waitForTimeout(800);

      // 템플릿 적용 시 "현재 글을 덮어씁니다" 같은 확인 팝업이 뜨면 확인
      const overwriteConfirm = frame.locator(".se-popup-alert-confirm .se-popup-button-confirm").first();
      if (await overwriteConfirm.isVisible({ timeout: 3000 }).catch(() => false)) {
        await overwriteConfirm.click();
        await page.waitForTimeout(800);
      }
    }

    const titleArea = frame.locator(".se-title-text .se-text-paragraph, .se-documentTitle .se-text-paragraph").first();

    if (useTemplate && post.introLines && post.introLines.length && post.sections && post.sections.length) {
      await replaceShortText(page, titleArea, post.title);
      await page.waitForTimeout(500);
      // 템플릿의 정확한 자리에 본문만 채워 넣기 (목차/전체요약은 2단계에서 별도로)
      await fillBodyOnly(frame, page, post);
    } else {
      // 템플릿 없이: 본문을 통째로 비우고 새로 입력. bodyHtml이 없으면
      // introLines/sectionHeadingLines/sections를 자연스러운 글 형태로 합쳐서 만든다.
      // 주의: ".se-component-content .se-text-paragraph"는 제목 문단에도 매칭되므로
      // (제목도 se-component-content로 감싸져 있음), 제목 영역을 반드시 제외하고 찾아야 한다
      // — 안 그러면 본문 첫 줄이 제목 쪽 커서에 들어가 제목이 깨지는 버그가 생긴다.
      const bodyText = post.bodyHtml || composePlainBody(post);
      // 섹션 형태로 온 글은 인용구·구분선을 쓴 깔끔한 기본 틀로 쓴다 (styled:false면 예전처럼 글자만)
      const styledBlocks = !post.bodyHtml && post.sections && post.sections.length && post.styled !== false ? composeStyledBlocks(post) : null;
      const clearBody = async () => {
        const bodyAreaHandle = await frame.locator(":root").evaluateHandle(() => {
          const paras = Array.from(document.querySelectorAll(".se-component-content .se-text-paragraph"));
          return paras.find((p) => !p.closest(".se-title-text, .se-documentTitle, .se-table"));
        });
        const bodyArea = bodyAreaHandle.asElement();
        await bodyArea.scrollIntoViewIfNeeded();
        await bodyArea.click({ timeout: 15000 });
        await page.waitForTimeout(300);
        // 이어쓰기로 연 글에는 이전 내용이 남아 있으므로 본문 전체를 먼저 비운다.
        await page.keyboard.press("Control+a");
        await page.keyboard.press("Delete");
        await page.waitForTimeout(500);
      };

      // 드물게 입력 도중 줄이 통째로 사라지는 경우가 있어, 원문과 대조해서 틀리면 한 번 다시 쓰고
      // 그래도 틀리면 망가진 글을 저장하지 않도록 에러를 낸다.
      let check = { ok: false };
      for (let attempt = 0; attempt < 2 && !check.ok; attempt++) {
        await clearBody();
        if (styledBlocks) {
          await writeStyledBody(frame, page, styledBlocks);
          check = await verifyStyledBody(frame, page, styledBlocks);
        } else {
          await writePlainBody(frame, page, bodyText);
          check = await verifyPlainBody(frame, bodyText);
        }
      }
      if (!check.ok) {
        throw new Error(`본문이 원문과 다르게 입력돼서 저장하지 않았습니다 (${check.reason})`);
      }

      // 제목은 본문을 다 쓴 뒤에 마지막으로 입력한다. 본문 쪽 Ctrl+A가 제목까지
      // 같이 지워버리는 경우가 있는데, 순서를 이렇게 두면 그래도 제목이 항상 올바르게 남는다.
      // (제목이 길어 줄바꿈된 상태면 트리플클릭은 한 줄만 잡으므로 여기서도 Ctrl+A를 쓴다.)
      await titleArea.click({ timeout: 10000 });
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Delete");
      await typeText(page, post.title);
      await page.waitForTimeout(500);
    }

    // 챕터별 이미지: 소제목 아래에 올린다 (본문을 소제목 인용구 구조로 쓴 경우에만)
    let imageResults = [];
    const chapterPaths = post.chapterImagePaths || [];
    if (chapterPaths.some(Boolean) && !post.bodyHtml && post.sections && post.sections.length && post.styled !== false && !(useTemplate && post.introLines && post.introLines.length)) {
      const quotes = composeStyledBlocks(post).filter((b) => b.type === "quote");
      const jobs = [];
      quotes.forEach((b, qi) => {
        if (b.chapter !== undefined && chapterPaths[b.chapter]) jobs.push({ chapter: b.chapter, quoteIndex: qi, path: chapterPaths[b.chapter] });
      });
      imageResults = await insertChapterImages(frame, page, jobs);
    } else if (chapterPaths.some(Boolean)) {
      imageResults = chapterPaths.map((p, i) => (p ? { chapter: i, state: "failed", reason: "이 글쓰기 방식(템플릿)에서는 챕터 이미지를 자동으로 올리지 못해요" } : null)).filter(Boolean);
    }

    // 이미지 삽입 (툴바 '사진' 버튼 → 파일 업로드)
    for (const imgPath of post.imagePaths || []) {
      const photoBtn = frame.locator("button[data-name='image'], .se-image-toolbar-button").first();
      if (await photoBtn.isVisible().catch(() => false)) {
        const [fileChooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 10000 }).catch(() => null),
          photoBtn.click(),
        ]);
        if (fileChooser) {
          await fileChooser.setFiles(imgPath);
          await page.waitForTimeout(1500);
        }
      }
    }

    // 처음 에디터를 쓰면 뜨는 '도움말' 툴팁이 저장 버튼을 가리는 경우가 있어 먼저 닫아본다
    await page.keyboard.press("Escape").catch(() => {});
    const helpCloseBtn = frame.locator("button[class*='close'], .se-help-panel button").first();
    if (await helpCloseBtn.isVisible().catch(() => false)) {
      await helpCloseBtn.click().catch(() => {});
    }

    // 상단 '저장'(임시저장) 버튼 클릭 (겹치는 오버레이가 있을 수 있어 force 사용)
    const saveBtn = frame.locator("button:has-text('저장')").first();
    await saveBtn.click({ timeout: 15000, force: true });
    await page.waitForTimeout(2000);

    return { success: true, imageResults };
  } finally {
    await browser.close();
  }
}

/**
 * 2단계: 방금 저장한(또는 사용자가 직접 수정한) 최신 임시글을 열어서
 * 실제 현재 내용을 읽고, Claude로 목차 요약/전체요약을 생성한 뒤 채워 넣고 저장한다.
 */
async function finalizeTocAndSummary() {
  if (!BLOG_ID) throw new Error("환경변수 NAVER_BLOG_ID가 설정되어 있지 않습니다.");
  const { askClaude, extractJson } = require("./claude");

  const { browser, context } = await openVisibleContext();
  const page = await context.newPage();
  await page.bringToFront().catch(() => {});
  require("./session").notifyChrome("블로그 글쓰기 창");

  try {
    await page.goto(`https://blog.naver.com/${BLOG_ID}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.bringToFront().catch(() => {});

    let frame = page.frameLocator("#mainFrame");
    const writeBtn = frame.locator("a[href*='postwrite'], a[href*='Redirect=Write']").first();
    await writeBtn.waitFor({ state: "attached", timeout: 15000 });
    await writeBtn.evaluate((el) => el.click());
    await page.waitForTimeout(2000);

    frame = page.frameLocator("#mainFrame");

    // 이번엔 최신 임시글을 그대로 "이어서 작성"(확인)해서 열어야 한다.
    const confirmBtn = frame.locator(".se-popup-alert-confirm .se-popup-button-confirm").first();
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click();
      await page.waitForTimeout(1500);
    }

    await page.evaluate(() => {
      const helpTitle = Array.from(document.querySelectorAll("*")).find(
        (el) => el.children.length === 0 && el.textContent.trim() === "도움말"
      );
      const panel = helpTitle && (helpTitle.closest("[class*='help'], [class*='Help']") || helpTitle.parentElement);
      const closeBtn = panel && panel.querySelector("button, [role='button']");
      if (closeBtn) closeBtn.click();
    }).catch(() => {});
    await page.waitForTimeout(300);

    frame = page.frameLocator("#mainFrame");
    const currentSections = await readCurrentSections(frame);

    const prompt =
      `아래는 블로그 글의 5개 섹션 소제목과, 그중 실제로 작성된 본문 내용이야 (사용자가 직접 수정했을 수도 있음):\n\n` +
      currentSections
        .map((s, i) => `${i + 1}번 - 소제목: ${s.heading || "(없음)"}\n본문: ${s.body || "(없음)"}`)
        .join("\n\n") +
      `\n\n이 내용을 바탕으로:\n` +
      `- tocSummary: 전체 글을 한 줄로 아우르는 목차용 요약 문구 (10~25자)\n` +
      `- recapLines: 1~4번 섹션 내용을 각각 한 줄로 요약한 것 4개 + 5번(앞으로 계획) 한 줄, 총 5개.\n` +
      `  형식은 "핵심내용 + 결론"을 담은 한 문장. 번호는 붙이지 마.\n` +
      `다음 JSON 형식으로만 답해:\n` +
      `{"tocSummary": "...", "recapLines": ["1번 요약","2번 요약","3번 요약","4번 요약","앞으로 계획"]}`;

    const raw = await askClaude(prompt, { timeoutMs: 180000 });
    const { tocSummary, recapLines } = extractJson(raw);

    await fillTocAndSummary(frame, page, {
      sectionHeadings: currentSections.map((s) => s.heading),
      tocSummary,
      recapLines,
    });

    await page.keyboard.press("Escape").catch(() => {});
    const saveBtn = frame.locator("button:has-text('저장')").first();
    await saveBtn.click({ timeout: 15000, force: true });
    await page.waitForTimeout(2000);

    return { success: true, tocSummary, recapLines };
  } finally {
    await browser.close();
  }
}

/**
 * AI 글 생성 없이, 블로그 → 글쓰기 → 템플릿(앞으로 쓸 템플릿) 적용까지만 하고 멈춘다.
 * 저장도 하지 않는다 — 사용자가 눈에 보이는 그 크롬 창에서 직접 타이핑하도록 열어만 둔다.
 */
async function openTemplateEditor() {
  if (!BLOG_ID) throw new Error("환경변수 NAVER_BLOG_ID가 설정되어 있지 않습니다.");

  const { browser, context } = await openVisibleContext();
  const page = await context.newPage();
  await page.bringToFront().catch(() => {});
  require("./session").notifyChrome("블로그 글쓰기 창");

  // 주의: 여기서는 browser.close()를 하지 않는다 — 이건 CDP 연결 해제일 뿐이라 실제로는
  // 상관없지만, 굳이 연결을 끊을 필요도 없으므로 함수가 끝나도 그대로 열어둔 채로 반환한다.
  await page.goto(`https://blog.naver.com/${BLOG_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.bringToFront().catch(() => {});

  let frame = page.frameLocator("#mainFrame");
  const writeBtn = frame.locator("a[href*='postwrite'], a[href*='Redirect=Write']").first();
  await writeBtn.waitFor({ state: "attached", timeout: 15000 });
  await writeBtn.evaluate((el) => el.click());
  await page.waitForTimeout(2000);

  frame = page.frameLocator("#mainFrame");

  const continuePopupBtn = frame.locator(".se-popup-alert-confirm .se-popup-button-cancel").first();
  if (await continuePopupBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await continuePopupBtn.click();
    await page.waitForTimeout(500);
  }

  await page.evaluate(() => {
    const helpTitle = Array.from(document.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && el.textContent.trim() === "도움말"
    );
    const panel = helpTitle && (helpTitle.closest("[class*='help'], [class*='Help']") || helpTitle.parentElement);
    const closeBtn = panel && panel.querySelector("button, [role='button']");
    if (closeBtn) closeBtn.click();
  }).catch(() => {});
  await page.waitForTimeout(300);

  const tmplBtn = frame.locator(".se-template-toolbar-button").first();
  await tmplBtn.evaluate((el) => el.click());
  await page.waitForTimeout(1000);

  const myTmplTab = frame.getByText("내 템플릿", { exact: true }).first();
  await myTmplTab.evaluate((el) => el.click());
  await page.waitForTimeout(800);

  const targetTmpl = frame.getByText("앞으로 쓸 템플릿", { exact: true }).first();
  await targetTmpl.evaluate((el) => el.click());
  await page.waitForTimeout(800);

  const overwriteConfirm = frame.locator(".se-popup-alert-confirm .se-popup-button-confirm").first();
  if (await overwriteConfirm.isVisible({ timeout: 3000 }).catch(() => false)) {
    await overwriteConfirm.click();
    await page.waitForTimeout(800);
  }

  await page.keyboard.press("Escape").catch(() => {});
  await page.bringToFront().catch(() => {});

  return { success: true };
}

module.exports = { saveDraftToNaver, finalizeTocAndSummary, openTemplateEditor, _test: { composeStyledBlocks, writeStyledBody, verifyStyledBody, insertChapterImages } };
