// 체험단·구매자용 사용 키.
//
// 키 = "NBH-" + base64url(내용) + "." + base64url(서명)
//   내용: {n: 이름, s: 시작일(YYYY-MM-DD), e: 마지막 사용일(YYYY-MM-DD), id: 체험단 DB 페이지 id}
//   서명: Ed25519. 서명용 개인키(data/license-private.pem)는 블로그 주인 컴퓨터에만 있고,
//         프로그램에는 확인용 공개키만 들어 있어서 다른 사람은 키를 만들 수 없다.
//
// 개인키가 있는 컴퓨터(= 관리자)는 키 없이 쓴다.
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALvlPAnQtHYYI2koy0xcoLXIAaFMomunj64Ji/og2sew=
-----END PUBLIC KEY-----`;
const DATA = path.join(__dirname, "..", "data");
const LICENSE_PATH = path.join(DATA, "license.json");
const PRIVATE_KEY_PATH = path.join(DATA, "license-private.pem");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); // 한국 날짜

function isAdmin() {
  return fs.existsSync(PRIVATE_KEY_PATH);
}

/** 관리자 컴퓨터에서만: 시작일부터 days일 동안 쓸 수 있는 키를 만든다 */
function issue({ name, start = today(), days = 14, id = "" }) {
  if (!isAdmin()) throw new Error("키를 만들 수 있는 컴퓨터가 아니에요.");
  const end = new Date(new Date(start + "T00:00:00Z").getTime() + (days - 1) * 86400000).toISOString().slice(0, 10);
  const payload = Buffer.from(JSON.stringify({ n: name, s: start, e: end, id }));
  const sig = crypto.sign(null, payload, fs.readFileSync(PRIVATE_KEY_PATH, "utf-8"));
  return { key: `NBH-${b64u(payload)}.${b64u(sig)}`, start, end };
}

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
  const info = { name: p.n, start: p.s, end: p.e, daysLeft };
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
function status() {
  if (isAdmin()) return { ok: true, admin: true };
  const key = saved();
  if (!key) return { ok: false, reason: "사용 키를 입력해주세요." };
  return check(key);
}

function activate(key) {
  const r = check(key);
  if (!r.ok) return r;
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LICENSE_PATH, JSON.stringify({ key: String(key).trim(), activatedAt: new Date().toISOString() }, null, 2));
  return r;
}

module.exports = { isAdmin, issue, check, status, activate, today };
