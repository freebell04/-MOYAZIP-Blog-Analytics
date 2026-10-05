// 사용 횟수 익명 집계 (사용자가 처음 실행할 때 직접 동의한 경우에만 켜진다. 기본은 "보내지 않음").
//  - 보내는 것: 하루에 한 줄 — 날짜, 기기를 되돌릴 수 없게 바꾼 값(해시), 프로그램 버전, 기능별 사용 횟수 4가지
//  - 절대 보내지 않는 것: 글 내용, 제목, 이웃·댓글, 네이버 아이디·블로그 주소, 이름, 사용 키
//  - 설정(동의/거부)은 언제든 바꿀 수 있고, 거부하면 그 뒤로는 아무것도 보내지 않는다.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const STATE_PATH = path.join(__dirname, "..", "data", "usage.json");
const EVENTS = { ai: "ai", draft: "draft", image: "image", visit: "visit" };
const kstDay = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

function read() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}
function write(s) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

/** consent: null(아직 안 물어봄) | true | false */
const getConsent = () => (read().consent === undefined ? null : read().consent);
function setConsent(v) {
  const s = read();
  s.consent = !!v;
  if (!v) { s.days = {}; } // 거부하면 모아 둔 횟수도 지운다
  write(s);
  if (v) flush().catch(() => {});
  return s.consent;
}

/** 기능을 한 번 썼다고 센다 (동의한 경우에만 기록한다) */
function track(event) {
  if (!EVENTS[event]) return;
  const s = read();
  if (s.consent !== true) return;
  const d = kstDay();
  s.days ||= {};
  const row = (s.days[d] ||= { ai: 0, draft: 0, image: 0, visit: 0 });
  row[event]++;
  // 최근 3일 것만 남긴다
  for (const k of Object.keys(s.days).sort().slice(0, -3)) delete s.days[k];
  write(s);
}

const deviceHash = () => crypto.createHash("sha256").update("nbh-usage|" + require("./license").deviceId()).digest("hex").slice(0, 16);
function version() {
  try {
    return fs.readFileSync(path.join(__dirname, "..", ".version"), "utf-8").trim().slice(0, 7) || "dev";
  } catch {
    return "dev";
  }
}

let flushing = false;
/** 오늘 것(과 아직 못 보낸 어제 것)을 서버로 보낸다. 실패해도 조용히 넘어간다 */
async function flush() {
  if (flushing) return;
  const s = read();
  if (s.consent !== true || !s.days) return;
  const base = require("./license").TRIAL_URL;
  if (!base) return;
  flushing = true;
  try {
    const today = kstDay();
    const yesterday = new Date(Date.now() + 9 * 3600000 - 86400000).toISOString().slice(0, 10);
    for (const day of [yesterday, today]) {
      const c = s.days[day];
      if (!c) continue;
      const sig = JSON.stringify(c);
      if (s.sent && s.sent[day] === sig) continue; // 바뀐 게 없으면 다시 안 보낸다
      const r = await fetch(base.replace(/\/$/, "") + "/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device: deviceHash(), day, version: version(), counts: c }),
        signal: AbortSignal.timeout(10000),
      }).catch(() => null);
      if (r && r.ok) {
        const t = read();
        (t.sent ||= {})[day] = sig;
        write(t);
      }
    }
  } finally {
    flushing = false;
  }
}

/** 서버가 켜져 있는 동안 30분마다(와 켠 직후) 보낸다 */
function start() {
  setTimeout(() => flush().catch(() => {}), 20000).unref();
  setInterval(() => flush().catch(() => {}), 30 * 60 * 1000).unref();
}

module.exports = { getConsent, setConsent, track, flush, start };
