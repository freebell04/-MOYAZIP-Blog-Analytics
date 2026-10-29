// 해시태그 설정: AI에게 받을 개수(0~30), 글마다 항상 넣을 태그. data/hashtag-settings.json
// 임시저장할 때 글 맨 끝에 "#태그 #태그 …" 한 줄로 넣는다 (네이버는 본문 속 #태그를 글 태그로 같이 등록한다, 최대 30개)
const path = require("path");
const fs = require("fs");

const FILE = path.join(__dirname, "..", "data", "hashtag-settings.json");
const MAX = 30;
const DEFAULTS = { count: 15, fixed: [] }; // 기본 15개 (검색 키워드 위주), 최대 30개까지 고를 수 있다

/** 태그 목록 정리: # 떼기, 띄어쓰기·특수문자 빼기(네이버 태그는 글자·숫자·_ 만), 중복 빼기, 최대 30개 */
function clean(list) {
  const arr = Array.isArray(list) ? list : String(list || "").split(/[\s,#]+/);
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const t = String(raw || "").replace(/[^\p{L}\p{N}_]/gu, "").slice(0, 30);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX) break;
  }
  return out;
}

function get() {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    const count = Math.max(0, Math.min(MAX, parseInt(o.count, 10)));
    return { count: Number.isFinite(count) ? count : DEFAULTS.count, fixed: clean(o.fixed) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save({ count, fixed }) {
  const cur = get();
  const n = parseInt(count, 10);
  const next = {
    count: Number.isFinite(n) ? Math.max(0, Math.min(MAX, n)) : cur.count,
    fixed: fixed === undefined ? cur.fixed : clean(fixed),
  };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

module.exports = { MAX, clean, get, save };
