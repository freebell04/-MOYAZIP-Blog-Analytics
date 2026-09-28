// 네이버 로그인 세션(쿠키) 저장/재사용 관리
//
// 이 환경(Claude Code 자동화)에서는 Playwright로 headless:false 새 창을 띄우는 게
// Windows 창스테이션 제약으로 항상 실패한다(spawn UNKNOWN). 그래서 Playwright로 직접
// 띄우는 대신, 일반 OS 프로세스로 크롬을 "디버그 모드"로 띄우고 CDP로 연결해서
// 로그인 쿠키를 가져오는 방식을 쓴다. 이후 자동화는 저장된 쿠키 + headless:true로 동작.
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

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
async function ensureDebugChrome() {
  if (await isCdpUp()) return { alreadyRunning: true };

  const chromePath = findChromePath();
  if (!chromePath) throw new Error("크롬 실행 파일을 찾을 수 없습니다 (C:\\Program Files\\Google\\Chrome\\...).");

  const child = spawn(chromePath, [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${CHROME_PROFILE_DIR}`], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // 포트가 뜰 때까지 최대 10초 대기
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await isCdpUp()) return { alreadyRunning: false };
  }

  throw new Error("크롬을 띄웠지만 디버그 포트(9222)가 열리지 않았습니다. 잠시 후 다시 시도해주세요.");
}

/**
 * 쿠키가 남아 있어도 서버에선 로그아웃된 경우가 있어서, 네이버에 실제 로그인 상태를 물어본다.
 * (새 탭을 잠깐 열었다 닫음)
 */
async function isReallyLoggedIn(context) {
  const page = await context.newPage();
  try {
    // API를 주소창으로 직접 열면 403이라, m.blog 페이지 안에서 fetch 한다
    await page.goto("https://m.blog.naver.com/", { waitUntil: "domcontentloaded" });
    const json = await page.evaluate(async () => (await fetch("/api/current-user", { credentials: "include" })).json());
    return !!(json && json.result && json.result.loggedIn);
  } catch {
    return false;
  } finally {
    await page.close().catch(() => {});
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

  // 항상 새 탭을 열어서 사용자 눈에 보이게 하고, 맨 앞으로 띄운다
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

  watchState = { watching: true, error: null };
  // 완료를 기다리지 않고 백그라운드로 계속 확인 (browser는 CDP 연결이라 닫아도 실제 크롬은 안 닫힘,
  // 다만 워치 도중엔 연결을 계속 들고 있어야 하므로 finally에서만 close)
  watchLoop(context, 10 * 60 * 1000).finally(() => browser.close());

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
  SESSION_PATH,
  CDP_URL,
};
