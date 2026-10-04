// 챕터 이미지 고르기: 크롬에서 이미지 검색을 열어주고, 사용자가 마음에 드는 이미지를 클릭하면
// 그 이미지를 가져와서 PNG로 바꾸고 윈도우 클립보드에 복사해 둔다. 사용자는 네이버 글쓰기 창에서 Ctrl+V만 하면 된다.
//
// 흐름: [앱] 검색어 버튼 → [크롬] 새 탭에 이미지 검색 열림 + 초록 안내줄 → 사용자가 이미지 클릭
//       → (탭 안에 심어둔 스크립트가 클릭한 이미지 주소를 기록) → 서버가 0.4초마다 읽어서 이미지를 받아옴
//       → PNG 변환 → data/images 에 저장 → 윈도우 클립보드에 이미지로 복사 → 크롬 화면에 "복사했어요" 안내
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
// Playwright는 크고(불러오는 데 0.2초) 켤 때는 필요 없어서, 처음 쓰는 순간에 불러온다
const chromium = new Proxy({}, { get: (_, k) => { const c = require("playwright").chromium; const v = c[k]; return typeof v === "function" ? v.bind(c) : v; } });
const session = require("./session");
const { connectPage } = require("./like");

const IMG_DIR = path.join(__dirname, "..", "data", "images");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

const ENGINES = {
  naver: (q) => `https://search.naver.com/search.naver?where=image&query=${enc(q)}`,
  google: (q) => `https://www.google.com/search?tbm=isch&q=${enc(q)}`,
  unsplash: (q) => `https://unsplash.com/s/photos/${enc(q.trim().replace(/\s+/g, "-"))}`,
  pexels: (q) => `https://www.pexels.com/search/${enc(q.trim())}/`,
  pixabay: (q) => `https://pixabay.com/images/search/${enc(q.trim())}/`,
};

// 크롬 탭 안에 심는 스크립트 (lib/imagePickInject.js 를 글자 그대로 읽어서 탭에 넣는다).
// 네이버 이미지 검색의 작은 이미지는 search.pstatic.net/common/?src=<원본주소> 형태라서, 그 안에서 원본 주소를 따로 뽑아 둔다.
const PICK_SCRIPT = fs.readFileSync(path.join(__dirname, "imagePickInject.js"), "utf-8");

// ---------------------------------------------------------------------------
// 이미지 받아오기·변환·저장·클립보드
// ---------------------------------------------------------------------------
const privateHost = (h) => /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/i.test(h);

/** 주소(또는 data:)에서 이미지 바이트를 받아온다 */
async function download(src, pageUrl) {
  if (src.startsWith("data:")) {
    const m = src.match(/^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw new Error("이미지 데이터를 읽지 못했어요");
    return { buf: Buffer.from(m[2], "base64"), mime: m[1] };
  }
  let u;
  try { u = new URL(src); } catch { throw new Error("이미지 주소가 올바르지 않아요"); }
  if (!/^https?:$/.test(u.protocol) || privateHost(u.hostname)) throw new Error("이 주소는 가져올 수 없어요");
  let referer = u.origin + "/";
  try { referer = new URL(pageUrl).origin + "/"; } catch {}
  const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": UA, accept: "image/*,*/*;q=0.5", referer } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const mime = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^image\//.test(mime)) throw new Error("이미지가 아니에요");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 15 * 1024 * 1024) throw new Error("이미지가 너무 커요");
  return { buf, mime };
}

/** 어떤 형식(webp·avif·gif·jpg…)이든 PNG로 바꾼다 (윈도우 클립보드·네이버 에디터에 붙여넣기 쉽게). 너무 크면 가로 2000px로 줄인다. */
async function toPng(buf, mime) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const url = `data:${mime || "image/png"};base64,${buf.toString("base64")}`;
    const out = await page.evaluate(async (u) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      const sc = Math.min(1, 2000 / img.naturalWidth);
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * sc));
      c.height = Math.max(1, Math.round(img.naturalHeight * sc));
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; // 투명 배경은 흰색으로
      x.fillRect(0, 0, c.width, c.height);
      x.drawImage(img, 0, 0, c.width, c.height);
      return { data: c.toDataURL("image/png"), w: c.width, h: c.height };
    }, url);
    return { png: Buffer.from(out.data.split(",")[1], "base64"), w: out.w, h: out.h };
  } finally {
    await browser.close();
  }
}

function savePng(png) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const file = `chapter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`;
  fs.writeFileSync(path.join(IMG_DIR, file), png);
  return file;
}

/** 저장된 이미지 파일을 윈도우 클립보드에 "이미지"로 복사한다 (STA 필요 → powershell -STA). 프로그램이 끝나도 남도록 persist */
function copyImageToClipboard(file) {
  return new Promise((resolve, reject) => {
    const abs = path.join(IMG_DIR, file);
    if (!/^chapter-[\w-]+\.png$/.test(file) || !fs.existsSync(abs)) return reject(new Error("복사할 이미지 파일을 찾지 못했어요"));
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
      "$src = [System.Drawing.Image]::FromFile($env:NBH_IMG); $bmp = New-Object System.Drawing.Bitmap($src); $src.Dispose(); " +
      "$d = New-Object System.Windows.Forms.DataObject; $d.SetImage($bmp); [System.Windows.Forms.Clipboard]::SetDataObject($d, $true); " +
      "if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }";
    const ps = spawn("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], { env: { ...process.env, NBH_IMG: abs }, windowsHide: true });
    let err = "";
    ps.stderr.on("data", (d) => (err += d));
    ps.on("error", reject);
    ps.on("close", (code) => (code === 0 ? resolve() : reject(new Error("클립보드에 복사하지 못했어요" + (err ? ": " + err.split("\n")[0].slice(0, 80) : "")))));
  });
}

// ---------------------------------------------------------------------------
// 고르기 세션 (한 번에 하나: 어느 챕터의 이미지를 고르는 중인지)
// status: opening | waiting(크롬에서 클릭을 기다림) | working(복사 중) | copied | closed | error
// ---------------------------------------------------------------------------
let state = { status: "idle" };
let current = null; // {client, targetId}

function getState() {
  const { client, ...pub } = state;
  return pub;
}

async function targetAlive(targetId) {
  const list = await (await fetch(`${session.CDP_URL}/json/list`)).json();
  return list.some((t) => t.id === targetId);
}

/** 클릭된 이미지 하나를 처리: 받아오기(원본 → 안 되면 화면에 보이던 주소) → PNG → 저장 → 클립보드 */
async function handlePick(s, click) {
  s.status = "working";
  s.error = "";
  const tries = [];
  if (click.original && click.original !== click.src) tries.push({ src: click.original, q: "원본 화질" });
  tries.push({ src: click.src, q: click.w && click.w < 500 ? "화면에 보이던 크기(작을 수 있어요)" : "화면에 보이던 크기" });
  let got = null;
  let lastErr = "";
  for (const t of tries) {
    try {
      const d = await download(t.src, click.page);
      got = { ...d, quality: t.q };
      break;
    } catch (e) {
      lastErr = e.message;
    }
  }
  if (!got) throw new Error(`이미지를 가져오지 못했어요 (${lastErr}). 다른 이미지를 클릭해 보세요.`);
  const { png, w, h } = await toPng(got.buf, got.mime);
  const file = savePng(png);
  await copyImageToClipboard(file);
  Object.assign(s, { status: "copied", file, previewUrl: `/images/${file}`, quality: got.quality, width: w, height: h, seq: (s.seq || 0) + 1, count: (s.count || 0) + 1 });
}

/** 이미지를 복사할 때마다 붙여넣을 블로그 글쓰기 창을 앞으로 가져온다. 글을 자동으로 입력하는 중에는 건드리지 않는다. */
async function bringEditorToFront() {
  try {
    const be = require("./blogEditor");
    if (be.isBusy && be.isBusy()) return;
    const list = await (await fetch(`${session.CDP_URL}/json/list`)).json();
    const t = list.find((x) => x.type === "page" && /postwrite|PostWriteForm|Redirect=Write/i.test(x.url));
    if (!t) return;
    await fetch(`${session.CDP_URL}/json/activate/${t.id}`);
    session.notifyChrome("블로그 글쓰기 창 — 넣을 자리를 누르고 Ctrl+V");
  } catch {}
}

/**
 * 크롬에 새 탭을 열어 검색 결과를 보여주고, 클릭을 지켜본다 (바로 반환 — 진행은 getState()).
 * @param {{chapter:number, query:string, engine?:string, openUrl?:string}} opts   openUrl은 시험용으로만 쓴다
 */
async function startPick({ chapter, query, engine = "naver", openUrl }) {
  const q = String(query || "").trim();
  if (!q) throw new Error("검색어가 비어 있어요.");
  const url = openUrl || (ENGINES[engine] || ENGINES.naver)(q);
  if (current && current.client) current.client.close(); // 이전 고르기는 그만둔다 (탭은 그대로 둠)
  const s = (state = { status: "opening", chapter, query: q, engine, count: 0, seq: 0, armed: false });
  current = {};

  (async () => {
    try {
      await session.ensureDebugChrome();
      const version = await (await fetch(`${session.CDP_URL}/json/version`)).json();
      const browserWs = await connectPage(version.webSocketDebuggerUrl);
      const { targetId } = await browserWs.send("Target.createTarget", { url: "about:blank", newWindow: false });
      browserWs.close();
      s.targetId = targetId;
      session.notifyChrome("이미지 검색 창 — 마음에 드는 이미지를 클릭하세요");
      const port = new URL(session.CDP_URL).port || "9222";
      const client = await connectPage(`ws://localhost:${port}/devtools/page/${targetId}`);
      current.client = client;
      await client.send("Page.enable").catch(() => {});
      await client.send("Page.addScriptToEvaluateOnNewDocument", { source: PICK_SCRIPT }).catch(() => {}); // 페이지가 바뀌어도 다시 심어진다
      await Promise.race([client.send("Page.navigate", { url }).catch(() => {}), sleep(4000)]);
      client.send("Page.bringToFront").catch(() => {});
      s.status = "waiting";

      let installedAt = 0;
      while (s === state && !client.closed) {
        if (!(await targetAlive(targetId).catch(() => true))) return void (s.status = s.count ? "copied" : "closed");
        // 페이지가 다시 불러와졌으면 스크립트가 없을 수 있어 확인하고 심는다
        if (Date.now() - installedAt > 3000) {
          installedAt = Date.now();
          await client.eval(PICK_SCRIPT).catch(() => {});
          // 클릭 감지(안내줄)가 실제로 켜졌는지 확인해서 앱에 알려준다
          s.armed = !!(await client.eval(`!!document.getElementById("__nbh_bar")`).catch(() => false));
          s.pageUrl = String((await client.eval("location.href").catch(() => "")) || "").slice(0, 120);
        }
        const clicks = await client.eval("(window.__nbhPicks || []).splice(0)").catch(() => []);
        if (clicks && clicks.length) {
          const last = clicks[clicks.length - 1]; // 여러 번 눌렀으면 마지막 것
          try {
            await handlePick(s, last);
            await client.eval(`window.__nbhLock(true); window.__nbhToast(${JSON.stringify("✅ 복사했어요 (" + s.quality + ") → 블로그 글쓰기 창에서 넣을 자리를 누르고 Ctrl+V · 다른 이미지로 바꾸려면 이 줄을 눌러 잠금을 풀어주세요")})`).catch(() => {});
            bringEditorToFront(); // 붙여넣을 블로그 글쓰기 창을 바로 앞으로 (자동 입력 중이면 건드리지 않음)
          } catch (e) {
            s.status = "waiting";
            s.error = e.message;
            await client.eval(`window.__nbhToast(${JSON.stringify("⚠ " + e.message)}, false)`).catch(() => {});
          }
        }
        await sleep(400);
      }
    } catch (e) {
      s.status = "error";
      s.error = e.message;
    }
  })();
  return getState();
}

function stop() {
  if (current && current.client) current.client.close();
  current = null;
  state = { status: "idle" };
}

module.exports = { startPick, getState, stop, copyImageToClipboard, ENGINES, PICK_SCRIPT, _test: { download, toPng, savePng, handlePick } };
