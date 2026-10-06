// 네이버 로그인 세션(쿠키) 저장/재사용 관리
//
// 이 환경(Claude Code 자동화)에서는 Playwright로 headless:false 새 창을 띄우는 게
// Windows 창스테이션 제약으로 항상 실패한다(spawn UNKNOWN). 그래서 Playwright로 직접
// 띄우는 대신, 일반 OS 프로세스로 크롬을 "디버그 모드"로 띄우고 CDP로 연결해서
// 로그인 쿠키를 가져오는 방식을 쓴다. 이후 자동화는 저장된 쿠키 + headless:true로 동작.
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
// Playwright는 크고(불러오는 데 0.2초) 켤 때는 필요 없어서, 처음 쓰는 순간에 불러온다
const chromium = new Proxy({}, { get: (_, k) => { const c = require("playwright").chromium; const v = c[k]; return typeof v === "function" ? v.bind(c) : v; } });

const SESSION_PATH = path.join(__dirname, "..", "data", "session", "naver-state.json");
const SESSION_DIR = path.dirname(SESSION_PATH);
const CHROME_PROFILE_DIR = path.join(__dirname, "..", "data", "chrome-profile");
const CDP_URL = process.env.CHROME_CDP_URL || "http://localhost:9222";
const CDP_PORT = 9222;

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
if (!fs.existsSync(CHROME_PROFILE_DIR)) fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });

function hasSession() {
  return fs.existsSync(SESSION_PATH);
}

function clearSession() {
  if (hasSession()) fs.unlinkSync(SESSION_PATH);
}

function findChromePath() {
  return CHROME_PATHS.find((p) => fs.existsSync(p));
}

async function isCdpUp() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 네이버 관련 쿠키만 걸러서, Playwright가 기대하는 형식으로 정제해 저장한다.
 * (디버그 크롬은 사용자의 평소 프로필이라 구글/어도비 등 무관한 사이트 쿠키가 잔뜩 섞여있고,
 * 그중 일부는 expires가 소수점이거나 sameSite 값이 이상해서 그대로 저장하면
 * 나중에 headless launch용 newContext({storageState})에서 "Invalid cookie fields" 에러가 난다.)
 */
async function saveNaverSession(context) {
  const cookies = await context.cookies(["https://www.naver.com", "https://nid.naver.com", "https://blog.naver.com"]);
  const clean = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires && c.expires > 0 ? Math.floor(c.expires) : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: ["Strict", "Lax", "None"].includes(c.sameSite) ? c.sameSite : "Lax",
  }));
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ cookies: clean, origins: [] }, null, 2));
}

/**
 * 디버그 모드 크롬(전용 프로필)이 떠있는지 확인하고, 없으면 새로 띄운다.
 * @returns {Promise<{alreadyRunning: boolean}>}
 */
/** 탭 하나가 응답하는지 (CDP로 간단한 계산을 시켜본다). 멈춘 탭은 응답이 없다. */
function tabResponds(wsUrl, ms = 2000) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws && ws.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), ms);
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "1", returnByValue: true } }));
      ws.onmessage = (ev) => { try { if (JSON.parse(ev.data).id === 1) finish(true); } catch {} };
      ws.onerror = () => finish(false);
    } catch {
      finish(false);
    }
  });
}

/**
 * 크롬이 오래 켜져 있으면 일부 탭이 멈춰서(응답 없음) Playwright가 크롬에 연결하다가 30초를 기다린 뒤 실패한다
 * ("connectOverCDP: Timeout"). 연결하기 전에 멈춘 탭을 찾아서, 앞으로 가져와 깨워보고 그래도 안 되면 닫는다.
 * 글쓰기 화면은 임시저장 안 한 글이 있을 수 있어서 응답이 없어도 닫지 않는다.
 */
async function closeHungTabs() {
  const closed = [];
  try {
    const list = (await (await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(3000) })).json()).filter((t) => t.type === "page" && /^https?:/.test(t.url) && t.webSocketDebuggerUrl);
    const states = await Promise.all(list.map(async (t) => ({ t, ok: await tabResponds(t.webSocketDebuggerUrl) })));
    const hung = states.filter((s) => !s.ok).map((s) => s.t);
    // 멈춘 탭이 여러 개여도 오래 걸리지 않게 한꺼번에 처리한다
    await Promise.all(
      hung.map(async (t) => {
        await fetch(`${CDP_URL}/json/activate/${t.id}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
        await sleep(1200);
        if (await tabResponds(t.webSocketDebuggerUrl, 2000)) return; // 깨어났다
        if (/postwrite|PostWriteForm|Redirect=Write/i.test(t.url)) return; // 글쓰기 탭은 건드리지 않는다
        await fetch(`${CDP_URL}/json/close/${t.id}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
        closed.push(t.url);
      })
    );
    // 앞으로 가져와 본 탭 중 하나가 화면을 차지하고 있을 수 있어서, 남은 탭 중 처음 것을 다시 앞으로
    if (hung.length) {
      const rest = (await (await fetch(`${CDP_URL}/json/list`)).json()).filter((t) => t.type === "page" && /^https?:/.test(t.url));
      if (rest[0]) await fetch(`${CDP_URL}/json/activate/${rest[0].id}`).catch(() => {});
    }
  } catch {}
  if (closed.length) console.log(`[크롬 정리] 멈춰서 응답 없는 탭 ${closed.length}개를 닫았어요:`, closed.map((u) => u.slice(0, 60)).join(" | "));
  return closed;
}

// 크롬 창이 열리거나 앞으로 나올 때마다 화면(대시보드)에 "주황빛을 확인해주세요" 안내를 띄우기 위한 신호.
// 윈도우는 뒤에 있는 창이 앞으로 나오려 하면 포커스를 뺏지 않고 작업 표시줄 아이콘을 주황색으로 깜빡인다.
// 화면 쪽(public/chrome-notice.js)이 /api/chrome-notice 를 지켜보다가 id가 바뀌면 안내를 띄운다.
let chromeNotice = { id: 0, at: 0, reason: "" };
function notifyChrome(reason) {
  chromeNotice = { id: chromeNotice.id + 1, at: Date.now(), reason: String(reason || "") };
}
const getChromeNotice = () => chromeNotice;

/**
 * 이 프로그램 전용 크롬 프로필을 쥐고 있는데 디버그 포트(9222)는 안 열린 크롬을 정리한다.
 * (창을 닫아도 크롬이 백그라운드에 남아 있으면, 새로 띄운 크롬이 그 크롬에 합쳐지면서 포트가 열리지 않아
 *  "됐다 안 됐다" 하고 로그인 창도 안 뜨는 증상이 생긴다.) 사용자의 평소 크롬(다른 프로필)은 건드리지 않는다.
 */
function killStaleProfileChrome() {
  try {
    const marker = CHROME_PROFILE_DIR.replace(/'/g, "''");
    require("child_process").execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { timeout: 15000, windowsHide: true, stdio: "ignore" }
    );
  } catch {}
}

/** 디버그 포트로 떠 있는 크롬의 --user-data-dir 값 (없으면 "") */
function runningProfileDir() {
  try {
    const out = require("child_process").execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '--remote-debugging-port=${CDP_PORT}' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1 -ExpandProperty CommandLine`],
      { timeout: 10000, windowsHide: true }
    ).toString();
    const m = out.match(/--user-data-dir=(?:"([^"]+)"|(\S+))/);
    return m ? (m[1] || m[2]) : "";
  } catch {
    return "";
  }
}

/** 열려 있는 크롬 창(탭)이 하나라도 있는지 */
async function hasOpenPage() {
  try {
    const list = await (await fetch(`${CDP_URL}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
    return list.some((t) => t.type === "page");
  } catch {
    return false;
  }
}

/**
 * 크롬 프로세스는 떠 있어 포트(9222)는 열려 있는데 창을 전부 닫아서 탭이 하나도 없는 상태에서는
 * 새 탭을 만들 수 없다 ("Failed to open new tab - no browser is open"). 이럴 땐 같은 프로필로 크롬을 한 번 더
 * 실행해서(이미 켜진 크롬이 받아서) 새 창을 하나 열어준다.
 */
async function ensureWindow() {
  if (await hasOpenPage()) return;
  const chromePath = findChromePath();
  if (!chromePath) return;
  // 9222 포트를 실제로 쥐고 있는 크롬이 쓰는 프로필 폴더로 연다 (다른 폴더에 설치한 프로그램의 크롬일 수도 있어서)
  const dir = runningProfileDir() || CHROME_PROFILE_DIR;
  spawn(chromePath, [`--user-data-dir=${dir}`, "about:blank"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    if (await hasOpenPage()) return;
  }
  // 그래도 창이 안 생기면 크롬이 제대로 응답하지 않는 상태 → 이 프로필의 크롬을 정리하고 처음부터 다시 띄운다
  killStaleProfileChrome();
  await sleep(1500);
}

async function ensureDebugChrome(opts = {}) {
  if (await isCdpUp()) {
    await ensureWindow();
    if (await isCdpUp()) {
      if (!opts.quick) await closeHungTabs(); // Playwright로 붙을 때만 필요한 정리 (AI 창 열기에는 건너뛰어 빠르게)
      return { alreadyRunning: true };
    }
  }

  const chromePath = findChromePath();
  if (!chromePath) throw new Error("크롬 실행 파일을 찾을 수 없습니다 (C:\\Program Files\\Google\\Chrome\\...).");

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      killStaleProfileChrome(); // 첫 시도에 포트가 안 열렸으면, 백그라운드에 남은 크롬을 정리하고 한 번 더
      await sleep(1200);
    }
    const child = spawn(chromePath, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${CHROME_PROFILE_DIR}`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    notifyChrome("크롬이 새로 열렸어요");
    // 포트가 뜰 때까지 최대 8초 대기
    for (let i = 0; i < 16; i++) {
      await sleep(500);
      if (await isCdpUp()) return { alreadyRunning: false };
    }
  }

  throw new Error("크롬을 띄웠지만 디버그 포트(9222)가 열리지 않았습니다. 열려 있는 크롬 창을 모두 닫고 다시 시도해주세요.");
}

/**
 * 쿠키가 남아 있어도 서버에선 로그아웃된 경우가 있어서, 네이버에 실제 로그인 상태를 물어본다.
 * 크롬에 탭을 열지 않고, 크롬의 쿠키만 꺼내서 서버(Node)에서 직접 요청한다.
 * (예전엔 3초마다 새 탭을 열었다 닫아서, 로그인 창에서 입력하는 중에 화면이 자꾸 그 탭으로 넘어갔다)
 */
async function isReallyLoggedIn(context) {
  try {
    const cookies = await context.cookies(["https://m.blog.naver.com", "https://nid.naver.com", "https://www.naver.com"]);
    if (!cookies.some((c) => c.name === "NID_AUT")) return false; // 로그인 쿠키가 아직 없으면 물어볼 필요도 없다
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    // referer가 없으면 403이 난다
    const res = await fetch("https://m.blog.naver.com/api/current-user", {
      headers: { cookie, referer: "https://m.blog.naver.com/", "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return !!(json && json.result && json.result.loggedIn);
  } catch {
    return false;
  }
}

let watchState = { watching: false, error: null };

/**
 * 로그인 상태를 백그라운드에서 계속 확인하다가, 로그인되는 순간 자동으로 세션을 저장한다.
 * 버튼을 다시 누를 필요 없이, 크롬에서 로그인만 하면 알아서 감지된다.
 */
async function watchLoop(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {

      if (await isReallyLoggedIn(context)) {
        await saveNaverSession(context);
        return;
      }
      await sleep(3000);
    }
    watchState.error = "로그인 대기 시간이 초과되었습니다 (10분). 다시 시도해주세요.";
  } catch (e) {
    watchState.error = e.message;
  } finally {
    watchState.watching = false;
  }
}

/**
 * 버튼을 누를 때마다 항상 새 탭으로 네이버를 열어서 화면 앞으로 띄운다(눈으로 보이게).
 * 이미 로그인되어 있으면 그 자리에서 바로 세션을 갱신하고 끝내고,
 * 아니면 로그인 폼으로 이동시킨 뒤 백그라운드로 로그인 완료를 감지한다.
 * (즉시 반환 — 이후 진행 상태는 클라이언트가 /api/session-status 로 폴링)
 */
async function startLoginWatch() {
  if (watchState.watching) return { watching: true }; // 이미 감지 중이면 중복 실행 방지

  await ensureDebugChrome();

  const browser = await chromium.connectOverCDP(CDP_URL);
  let context = browser.contexts()[0];
  if (!context) context = await browser.newContext();

  // 이미 로그인돼 있으면 탭을 열지 않고 바로 끝낸다 (화면이 불필요하게 뜨거나 연결이 꼬이는 일이 없게)
  if (await isReallyLoggedIn(context)) {
    await saveNaverSession(context);
    await browser.close().catch(() => {});
    return { alreadyLoggedIn: true };
  }

  // 로그인이 필요하면 새 탭을 열어서 사용자 눈에 보이게 하고, 맨 앞으로 띄운다
  const page = await context.newPage();
  await page.goto("https://www.naver.com", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.bringToFront().catch(() => {});

  if (await isReallyLoggedIn(context)) {
    await saveNaverSession(context);
    await browser.close();
    return { alreadyLoggedIn: true };
  }

  clearSession(); // 서버에선 로그아웃 상태이므로 옛 쿠키 파일은 버린다 (대시보드에 "로그인 필요"로 보이게)
  await page.goto("https://nid.naver.com/nidlogin.login", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.bringToFront().catch(() => {});
  // "로그인 상태 유지"만 미리 체크해둔다 (크롬을 껐다 켜도 로그인이 남게). 아이디·비밀번호는 건드리지 않고 사용자가 직접 입력한다
  await page.waitForSelector("#loginStay", { timeout: 4000 }).catch(() => {});
  await page.evaluate(() => { const k = document.querySelector("#loginStay"); if (k && !k.checked) k.click(); }).catch(() => {});
  notifyChrome("네이버 로그인 화면 — 크롬 맨 앞 탭 '네이버 로그인'에서 로그인해주세요");

  watchState = { watching: true, error: null };
  // 완료를 기다리지 않고 백그라운드로 계속 확인 (browser는 CDP 연결이라 닫아도 실제 크롬은 안 닫힘,
  // 다만 워치 도중엔 연결을 계속 들고 있어야 하므로 finally에서만 close)
  // browser.close()가 실패해도(예: 이미 끊긴 연결) 잡아주지 않으면 처리되지 않은 Promise 거부가 되어
  // Node가 서버 프로세스 전체를 종료시켜버린다 — 반드시 여기서 끝까지 잡아야 한다.
  watchLoop(context, 10 * 60 * 1000).finally(() => browser.close().catch(() => {}));

  return { watching: true };
}

function getLoginWatchState() {
  return watchState;
}

/**
 * 저장된 세션으로 로그인된 브라우저 컨텍스트를 연다 (항상 headless:true로 실행, 화면에 안 보임).
 */
async function openLoggedInContext() {
  if (!hasSession()) throw new Error("저장된 네이버 로그인 세션이 없습니다. 먼저 로그인해주세요.");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  return { browser, context };
}

/**
 * 로그인 때 쓰는 디버그 크롬(화면에 보이는 실제 창)에 연결해서 컨텍스트를 반환한다.
 * 블로그 작성 과정을 사용자가 눈으로 볼 수 있게 할 때 사용.
 * browser.close()는 CDP 연결 해제일 뿐 실제 크롬은 안 닫힌다.
 */
async function openVisibleContext() {
  await ensureDebugChrome();
  const browser = await chromium.connectOverCDP(CDP_URL);
  let context = browser.contexts()[0];
  if (!context) context = await browser.newContext();
  return { browser, context };
}

module.exports = {
  hasSession,
  clearSession,
  startLoginWatch,
  getLoginWatchState,
  openLoggedInContext,
  openVisibleContext,
  ensureDebugChrome,
  notifyChrome,
  getChromeNotice,
  SESSION_PATH,
  CDP_URL,
};
