// 🤖 AI가 자동으로 만드는 템플릿: 내 인기글을 바탕으로 네이버 에디터의 "내 템플릿"에 '앞으로 쓸 템플릿'을 만든다.
//  1) 인기글의 수정 화면(PostUpdateForm)을 연다 → 제목을 '앞으로 쓸 템플릿'으로 바꾼다
//  2) 템플릿 → 내 템플릿 → [현재 글 추가] (글 자체는 저장하지 않고 그 탭을 닫는다 = "나가기")
//  3) 새 글쓰기를 열고 방금 만든 템플릿을 적용해 둔다 → 사용자가 자리 글자(본문 제목·짧은 본문 등)로 고친다
//  4) [다 고쳤어요 → 템플릿으로 저장]: 고친 내용을 '앞으로 쓸 템플릿'으로 다시 저장 (예전 것은 지운다)
// 원래 글은 절대 저장·발행하지 않는다. 템플릿은 이름이 같은 것을 1개만 둔다.
const fs = require("fs");
const path = require("path");
const session = require("./session");

const NAME = process.env.NBH_TEMPLATE_NAME || "앞으로 쓸 템플릿"; // (테스트할 때만 다른 이름)
const STATE_PATH = path.join(__dirname, "..", "data", "template-maker.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")); } catch { return {}; } };
const writeState = (v) => { fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify({ ...readState(), ...v }, null, 2)); };

let job = { running: false, step: "", error: null };
const getState = () => ({ ...job, ...readState() });

async function closeHelp(page) {
  await page.evaluate(() => {
    const h = [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent.trim() === "도움말");
    const p = h && (h.closest("[class*='help']") || h.parentElement);
    const b = p && p.querySelector("button");
    if (b) b.click();
  }).catch(() => {});
}
async function openMyTemplates(page) {
  const panelOpen = await page.locator(".se-doc-template-add-button").first().isVisible().catch(() => false);
  if (!panelOpen) {
    await page.locator(".se-template-toolbar-button").first().evaluate((el) => el.click());
    await sleep(1200);
  }
  await page.locator(".se-tab-button", { hasText: "내 템플릿" }).first().click();
  // 목록이 늦게 그려진다: 템플릿이 보이거나 "총 0개"가 나올 때까지 기다린다 (안 기다리면 있는 걸 없다고 본다)
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    const ready = await page.evaluate(() => document.querySelectorAll(".se-doc-template-item").length > 0 || /총\s*0\s*개/.test((document.querySelector("[class*='template']") || {}).innerText || "")).catch(() => false);
    if (ready && i >= 1) break;
  }
}
const templateNames = (page) => page.evaluate(() => [...document.querySelectorAll(".se-doc-template-item")].map((it) => ((it.querySelector(".se-doc-template-title") || {}).innerText || "").trim()));
async function deleteTemplates(page, name) {
  for (let k = 0; k < 6; k++) {
    const idx = (await templateNames(page)).indexOf(name);
    if (idx < 0) return;
    const before = (await templateNames(page)).length;
    // "선택한 템플릿을 삭제하시겠습니까?" 확인창이 아예 뜨지 않게 '예'로 답해 둔다
    // (크롬에 붙어 있는 다른 연결이 그 창을 자동으로 '취소'해 버리는 경우가 있어서, 창이 뜨면 삭제가 안 될 수 있다)
    await page.evaluate(() => { window.confirm = () => true; }).catch(() => {});
    const it = page.locator(".se-doc-template-item").nth(idx);
    await it.scrollIntoViewIfNeeded().catch(() => {});
    await it.hover().catch(() => {});
    await sleep(300);
    await it.locator(".se-template-delete-button").click().catch(() => it.locator(".se-template-delete-button").click({ force: true }));
    // 목록이 줄어들 때까지 기다린다
    for (let w = 0; w < 12; w++) { await sleep(500); if ((await templateNames(page)).length < before) break; }
  }
}
/** 제목 칸을 name으로 바꾼다 (긴 제목은 여러 줄이라: 첫 줄 맨 앞에서 글자 수만큼 지우고 입력) */
async function setTitle(page, name) {
  const title = page.locator(".se-documentTitle .se-text-paragraph").first();
  const old = (await title.innerText().catch(() => "")).replace(/​/g, "");
  await title.click({ position: { x: 3, y: 8 } });
  await page.keyboard.press("Home");
  for (let i = 0; i < Array.from(old).length + 2; i++) await page.keyboard.press("Delete");
  await page.keyboard.type(name, { delay: 10 });
  await sleep(400);
  return (await title.innerText()).replace(/​/g, "").trim() === name;
}
async function addCurrentAsTemplate(page, name) {
  await openMyTemplates(page);
  const count = async () => (await templateNames(page)).filter((n) => n === name).length;
  const before = await count();
  await page.locator(".se-doc-template-add-button").first().click();
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if ((await count()) > before) return true; // 새로 하나 더 생겼을 때만 성공 (예전 것이 보이는 걸 착각하지 않게)
  }
  return false;
}
async function closeTab(context, page) {
  try {
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await fetch(`${session.CDP_URL}/json/close/${targetInfo.targetId}`).catch(() => {});
  } catch {
    await page.close({ runBeforeUnload: false }).catch(() => {});
  }
}

/** 이미 '앞으로 쓸 템플릿'이 블로그에 있는지 (새 글쓰기 화면을 잠깐 열지 않고, 수정 화면에서 확인) */
async function exists(page) {
  await openMyTemplates(page);
  return (await templateNames(page)).includes(NAME);
}

/**
 * @param logNo 바탕으로 쓸 내 글 번호 (인기글)
 * @param replace 이미 있으면 지우고 다시 만들기
 * @returns {exists:true} | {ok:true}
 */
async function create({ logNo, replace = false }) {
  if (job.running) throw new Error("이미 템플릿을 만드는 중이에요.");
  const blogId = require("./config").blogId();
  if (!blogId) throw new Error("블로그 아이디가 설정되어 있지 않아요.");
  if (!/^\d{6,}$/.test(String(logNo || ""))) throw new Error("바탕으로 쓸 글을 골라주세요.");
  job = { running: true, step: "인기글 수정 화면을 여는 중...", error: null };
  const { browser, context } = await session.openVisibleContext();
  const page = await context.newPage();
  try {
    require("./windowLayout").splitSoon([1500, 6000]);
    await page.goto(`https://blog.naver.com/PostUpdateForm.naver?blogId=${blogId}&logNo=${logNo}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".se-template-toolbar-button", { timeout: 25000 });
    await sleep(1500);
    await closeHelp(page);

    job.step = "내 템플릿 목록을 확인하는 중...";
    if (await exists(page)) {
      if (!replace) { await closeTab(context, page); job = { running: false, step: "", error: null }; return { exists: true }; }
      job.step = "예전 '앞으로 쓸 템플릿'을 지우는 중...";
      await deleteTemplates(page, NAME);
    }
    await page.locator(".se-sidebar-close-button").first().click().catch(() => {}); // 패널을 닫아야 제목을 정확히 누를 수 있다
    await sleep(600);

    job.step = "제목을 '앞으로 쓸 템플릿'으로 바꾸는 중...";
    if (!(await setTitle(page, NAME))) throw new Error("제목을 바꾸지 못했어요. 다시 시도해주세요.");

    job.step = "템플릿으로 추가하는 중... (원래 글은 저장하지 않아요)";
    if (!(await addCurrentAsTemplate(page, NAME))) throw new Error("템플릿을 추가하지 못했어요. 다시 시도해주세요.");

    job.step = "수정 화면을 저장하지 않고 닫는 중...";
    await closeTab(context, page);

    job.step = "새 글쓰기 화면에 템플릿을 불러오는 중...";
    await require("./blogEditor").openTemplateEditor({ name: NAME });
    writeState({ made: true, madeAt: new Date().toISOString(), fromLogNo: String(logNo), saved: false });
    job = { running: false, step: "", error: null };
    return { ok: true };
  } catch (e) {
    await closeTab(context, page).catch(() => {});
    job = { running: false, step: "", error: e.message };
    throw e;
  } finally {
    browser.close().catch(() => {});
  }
}

/** [다 고쳤어요 → 템플릿으로 저장]: 열려 있는 글쓰기 화면의 내용을 '앞으로 쓸 템플릿'으로 다시 저장한다 */
async function saveEdited() {
  if (job.running) throw new Error("이미 작업 중이에요.");
  job = { running: true, step: "글쓰기 화면을 찾는 중...", error: null };
  const { browser, context } = await session.openVisibleContext();
  try {
    const isWrite = (u) => /PostWriteForm|postwrite|Redirect=Write/i.test(u);
    const page = context.pages().reverse().find((p) => isWrite(p.url()) || p.frames().some((f) => isWrite(f.url())));
    if (!page) throw new Error("템플릿을 고치던 글쓰기 화면을 찾지 못했어요. [AI가 자동으로 만드는 템플릿]을 다시 눌러주세요.");
    let target = page.mainFrame();
    for (const f of page.frames()) if (await f.$(".se-template-toolbar-button").catch(() => null)) { target = f; break; }
    job.step = "제목을 '앞으로 쓸 템플릿'으로 맞추는 중...";
    await target.locator(".se-sidebar-close-button").first().click().catch(() => {});
    if (!(await setTitle(wrap(page, target), NAME))) throw new Error("제목을 바꾸지 못했어요. 글쓰기 화면을 앞에 둔 채로 다시 눌러주세요.");
    job.step = "예전 템플릿을 지우고 새로 저장하는 중...";
    await openMyTemplates(wrap(page, target));
    await deleteTemplates(wrap(page, target), NAME);
    if (!(await addCurrentAsTemplate(wrap(page, target), NAME))) throw new Error("템플릿 저장을 확인하지 못했어요. 다시 눌러주세요.");
    writeState({ saved: true, savedAt: new Date().toISOString() });
    job = { running: false, step: "", error: null };
    return { ok: true };
  } catch (e) {
    job = { running: false, step: "", error: e.message };
    throw e;
  } finally {
    browser.close().catch(() => {});
  }
}
// 글쓰기 화면은 #mainFrame 안에 에디터가 있을 수 있어서, 위 함수들이 쓰는 page.locator/evaluate/keyboard를 그 프레임으로 돌린다
function wrap(page, frame) {
  if (frame === page.mainFrame()) return page;
  return { locator: (s, o) => frame.locator(s, o), evaluate: (f, a) => frame.evaluate(f, a), keyboard: page.keyboard };
}

module.exports = { create, saveEdited, getState, NAME };
