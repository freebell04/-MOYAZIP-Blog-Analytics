// 이웃 글 공감(하트) 도우미.
// 대시보드 버튼을 누르면 로그인된 디버그 크롬에서 그 글을 새 탭으로 열어두고,
// 사용자가 직접 공감을 누르는지 지켜보다가 눌리면 완료로 기록한다.
// 공감을 대신 눌러주지는 않는다 (봇 감지·계정 제한 위험, 그리고 사용자가 직접 하는 게 원칙).
//
// Playwright(connectOverCDP)는 새 "창"으로 만든 페이지를 인식하지 못해서,
// 창은 CDP 명령으로 만들고 그 창의 디버그 웹소켓에 직접 붙어서 상태를 확인한다.
const path = require("path");
const fs = require("fs");
const session = require("./session");

const LIKED_PATH = path.join(__dirname, "..", "data", "neighbors-liked.json");
const WATCH_TIMEOUT_MS = 15 * 60 * 1000; // 창을 열어두고 15분 지나면 지켜보기 중단

function getLiked() {
  try {
    return JSON.parse(fs.readFileSync(LIKED_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function markLiked(key) {
  const liked = getLiked();
  liked[key] = new Date().toISOString();
  fs.writeFileSync(LIKED_PATH, JSON.stringify(liked, null, 2));
}

// key("blogId:logNo") -> { status: "opening" | "watching" | "liked" | "already" | "closed" | "timeout" | "error", error?, targetId? }
const watches = {};

function getWatches() {
  return watches;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 페이지 하나에 붙는 최소한의 CDP 클라이언트 */
function connectPage(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const client = {
      closed: false,
      send(method, params = {}) {
        return new Promise((res, rej) => {
          if (client.closed) return rej(new Error("closed"));
          const msgId = ++id;
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params }));
        });
      },
      async eval(expression) {
        const r = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        return r.result && r.result.value;
      },
      close() {
        client.closed = true;
        try {
          ws.close();
        } catch {}
      },
    };
    ws.onopen = () => resolve(client);
    ws.onerror = () => reject(new Error("창에 연결하지 못했어요."));
    ws.onclose = () => {
      client.closed = true;
      for (const p of pending.values()) p.rej(new Error("closed"));
      pending.clear();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
    };
  });
}

const PRESSED_JS = `[...document.querySelectorAll('a.u_likeit_list_button[data-type="like"], a.u_likeit_button._face')]
  .some((a) => a.getAttribute("aria-pressed") === "true")`;
// 공감 버튼은 처음엔 "안 눌림"으로 그려졌다가, 네이버가 내 공감 상태를 불러온 뒤에야 "눌림"으로 바뀐다.
// 그 요청(like/v1/search/contents)이 끝나기 전에 판정하면 "원래 공감한 글"을 "방금 공감함"으로 잘못 보게 된다.
const READY_JS = `!!document.querySelector('a.u_likeit_list_button[data-type="like"]') &&
  performance.getEntriesByType("resource").some((e) => e.name.includes("like/v1/search/contents") && e.responseEnd > 0)`;
const SCROLL_JS = `(() => {
  const el = document.querySelector(".u_likeit_list_module") || document.querySelector("a.u_likeit_button._face");
  if (el) el.scrollIntoView({ block: "center" });
})()`;

async function targetAlive(targetId) {
  const list = await (await fetch(`${session.CDP_URL}/json/list`)).json();
  return list.some((t) => t.id === targetId);
}

/** 새 탭으로 글을 열고 공감 여부를 지켜보기 시작한다 (바로 반환, 진행은 getWatches()로 확인). */
async function openAndWatch(blogId, logNo) {
  const key = `${blogId}:${logNo}`;
  const cur = watches[key];
  if (cur && cur.status === "watching" && cur.client) {
    await cur.client.send("Page.bringToFront").catch(() => {}); // 이미 열려 있으면 그 창을 앞으로
    session.notifyChrome("이웃 글 창");
    return;
  }
  if (cur && cur.status === "opening") return;
  const w = (watches[key] = { status: "opening" });

  try {
    await session.ensureDebugChrome();
    const url = `https://m.blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}`;

    // 로그인된 디버그 크롬 창에 새 탭으로 연다 (별도 창이 아니라 같은 창 안 탭)
    const version = await (await fetch(`${session.CDP_URL}/json/version`)).json();
    const browserWs = await connectPage(version.webSocketDebuggerUrl);
    const { targetId } = await browserWs.send("Target.createTarget", { url, newWindow: false });
    browserWs.close();
    w.targetId = targetId;

    const port = new URL(session.CDP_URL).port || "9222";
    const client = await connectPage(`ws://localhost:${port}/devtools/page/${targetId}`);
    w.client = client;
    await client.send("Page.bringToFront").catch(() => {});
    session.notifyChrome("이웃 글 창");

    // 공감 버튼은 스크롤해야 늦게 불러와져서, 아래로 내려가며 버튼이 생길 때까지 기다린 뒤 그 위치로 맞춘다
    let ready = false;
    for (let i = 0; i < 40 && !(ready = await client.eval(READY_JS).catch(() => false)); i++) {
      await client.eval("window.scrollTo(0, document.documentElement.scrollHeight)").catch(() => {});
      await sleep(400);
    }
    if (!ready) throw new Error("공감 상태를 불러오지 못했어요. 탭에서 직접 확인해주세요.");
    await sleep(700); // 응답이 화면에 반영될 시간
    await client.eval(SCROLL_JS).catch(() => {});

    if (await client.eval(PRESSED_JS).catch(() => false)) {
      markLiked(key);
      w.status = "already";
      return;
    }
    w.status = "watching";

    // 창이 닫히거나 시간이 다 될 때까지 지켜본다
    const deadline = Date.now() + WATCH_TIMEOUT_MS;
    while (w.status === "watching") {
      if (client.closed || !(await targetAlive(targetId).catch(() => true))) {
        w.status = "closed";
        break;
      }
      if (Date.now() > deadline) {
        w.status = "timeout";
        break;
      }
      if (await client.eval(PRESSED_JS).catch(() => false)) {
        markLiked(key);
        w.status = "liked";
        break;
      }
      await sleep(800);
    }
  } catch (e) {
    w.status = "error";
    w.error = e.message;
  } finally {
    // 연결만 끊는다 (창은 사용자가 댓글 쓰는 중일 수 있으니 닫지 않음)
    if (w.client) w.client.close();
    delete w.client;
  }
}

module.exports = { openAndWatch, getWatches, getLiked, connectPage };
