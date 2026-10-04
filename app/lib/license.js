// 체험단·구매자용 사용 키.
//
// 키 = "NBH-" + base64url(내용) + "." + base64url(서명)
//   내용: {n: 이름, s: 시작일(YYYY-MM-DD), e: 마지막 사용일(YYYY-MM-DD), id: 체험단 DB 페이지 id}
//   서명: Ed25519. 키는 블로그 주인 컴퓨터에만 있는 별도의 '체험단 관리자' 프로그램이 만들고,
//         이 프로그램에는 확인용 공개키만 들어 있어서 다른 사람은 키를 만들 수 없다.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALvlPAnQtHYYI2koy0xcoLXIAaFMomunj64Ji/og2sew=
-----END PUBLIC KEY-----`;
const DATA = path.join(__dirname, "..", "data");
const LICENSE_PATH = path.join(DATA, "license.json");
const SIGNED_PATH = path.join(DATA, "signed-up.json");
/** 이 컴퓨터에서 이미 가입(체험 시작)했거나 키를 한 번이라도 넣었는지 */
const signedUp = () => fs.existsSync(SIGNED_PATH) || !!saved();

// 자동 무료 체험 서버(Cloudflare Worker) 주소. 비어 있으면 키 입력 화면에 "무료 체험 시작"이 나오지 않는다.
const TRIAL_URL = process.env.NBH_TRIAL_URL || "https://blog-studio-trial.moyazip-studio.workers.dev";

const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 한국 날짜

/** 키 확인. {ok, name, start, end, daysLeft, reason} */
function check(key) {
  const m = String(key || "").trim().match(/^NBH-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) return { ok: false, reason: "키 형식이 올바르지 않아요. 받은 키를 그대로 붙여넣어 주세요." };
  const payload = Buffer.from(m[1], "base64url");
  let valid = false;
  try {
    valid = crypto.verify(null, payload, PUBLIC_KEY, Buffer.from(m[2], "base64url"));
  } catch {}
  if (!valid) return { ok: false, reason: "올바른 키가 아니에요." };
  const p = JSON.parse(payload.toString("utf-8"));
  const t = today();
  const daysLeft = Math.round((new Date(p.e + "T00:00:00Z") - new Date(t + "T00:00:00Z")) / 86400000) + 1;
  const info = { name: p.n, start: p.s, end: p.e, daysLeft, id: p.id || "", blog: p.b || "" };
  if (t < p.s) return { ok: false, ...info, reason: `${p.s}부터 쓸 수 있는 키예요.` };
  if (t > p.e) return { ok: false, ...info, expired: true, reason: `사용 기간이 끝났어요 (${p.s} ~ ${p.e}).` };
  return { ok: true, ...info };
}

function saved() {
  try {
    return JSON.parse(fs.readFileSync(LICENSE_PATH, "utf-8")).key || "";
  } catch {
    return "";
  }
}

/** 지금 이 컴퓨터에서 프로그램을 쓸 수 있는지 */
// 모든 화면·API 요청마다 호출되므로, 파일 읽기와 서명 검증 결과를 잠깐(5초) 기억해둔다
let cached = { at: 0, result: null };
function status() {
  if (cached.result && Date.now() - cached.at < 5000) return cached.result;
  const key = saved();
  const result = key ? check(key) : { ok: false, reason: "사용 키를 입력해주세요." };
  cached = { at: Date.now(), result };
  return result;
}

function activate(key) {
  const r = check(key);
  if (!r.ok) return r;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LICENSE_PATH, JSON.stringify({ key: String(key).trim(), activatedAt: new Date().toISOString() }, null, 2));
  fs.writeFileSync(SIGNED_PATH, JSON.stringify({ at: new Date().toISOString(), name: r.name })); // 한 번이라도 가입·키 입력을 했다는 표시 (지워도 다시 가입 안내를 띄우지 않는다)
  cached = { at: 0, result: null }; // 방금 넣은 키가 바로 적용되게
  return r;
}

/** 이 컴퓨터를 구분하는 값 (같은 컴퓨터가 여러 번 무료 체험을 받지 못하게 서버가 기억한다) */
function deviceId() {
  const p = path.join(DATA, "device.json");
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf-8")).id;
    if (d) return d;
  } catch {}
  const id = crypto.createHash("sha256").update(require("os").hostname() + "|" + crypto.randomBytes(16).toString("hex")).digest("hex").slice(0, 32);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id }));
  return id;
}

/** 이름·블로그를 서버에 보내 무료 체험(14일) 키를 받아 바로 적용한다 */
async function startTrial({ name, blog }) {
  if (!TRIAL_URL) return { ok: false, reason: "무료 체험 서버가 아직 준비되지 않았어요. 받으신 사용 키를 입력해주세요." };
  let res;
  try {
    res = await fetch(TRIAL_URL.replace(/\/$/, "") + "/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, blog, device: deviceId() }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    return { ok: false, reason: "체험 서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해주세요." };
  }
  const j = await res.json().catch(() => ({}));
  if (!j.ok) return { ok: false, reason: j.reason || "체험을 시작하지 못했어요.", closed: j.closed, expired: j.expired };
  const r = activate(j.key);
  return r.ok ? { ...r, existing: !!j.existing } : r;
}

const trialAvailable = () => !!TRIAL_URL;

module.exports = { check, status, activate, today, startTrial, trialAvailable, signedUp, TRIAL_URL };
