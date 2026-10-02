// 체험단 선정 (관리자 컴퓨터 전용 — license-private.pem 이 있는 컴퓨터)
//
// 노션 "체험단 관리" DB의 신청자를 불러와 → 신청자 블로그 활동을 자동 확인해 점수를 매기고 →
// 관리자가 고른 사람을 [선정]하면 사용 키를 발급해서 노션에 선정·시작일·사용 키를 기록한다.
// 노션 접근은 성과 통계에서 설정한 노션 통합 토큰을 그대로 쓴다 (체험단 DB에도 그 통합이 연결돼 있어야 함).
const path = require("path");
const fs = require("fs");
const notion = require("./notion");
const license = require("./license");

const OWNER_PATH = path.join(__dirname, "..", "data", "owner.json");
const DEFAULT_DB = "92ea6d86ee1d44769bbb4be0f05ce8c8"; // 체험단 관리
const TRIAL_DAYS = 14;

function dbId() {
  try {
    const o = JSON.parse(fs.readFileSync(OWNER_PATH, "utf-8"));
    if (o.trialDb) return notion.parseNotionId(o.trialDb) || o.trialDb;
  } catch {}
  return DEFAULT_DB;
}

function token() {
  const t = notion.getConfig().token;
  if (!t) throw new Error("노션 통합 토큰이 없어요. 성과 통계 → ⚙️ 노션 설정에서 먼저 연결해주세요.");
  return t;
}

const plain = (rich) => (rich || []).map((r) => r.plain_text).join("");
function readProps(page) {
  const p = page.properties || {};
  const v = (name) => {
    const x = p[name];
    if (!x) return null;
    switch (x.type) {
      case "title": return plain(x.title);
      case "rich_text": return plain(x.rich_text);
      case "url": return x.url;
      case "checkbox": return x.checkbox;
      case "select": return x.select && x.select.name;
      case "number": return x.number;
      case "date": return x.date && x.date.start;
      case "created_time": return x.created_time;
      case "formula": return x.formula && (x.formula.string ?? x.formula.number ?? null);
      default: return null;
    }
  };
  return {
    id: page.id,
    url: page.url,
    name: v("이름") || "(이름 없음)",
    contact: v("연락처") || "",
    channel: v("채널") || "",
    blogUrl: v("블로그 주소") || "",
    reason: v("신청 이유") || "",
    windows: v("Windows PC"),
    selection: v("선정") || "대기",
    score: v("활동 점수"),
    start: v("시작일"),
    end: v("종료일"),
    key: v("사용 키") || "",
    review: v("후기 제출"),
    appliedAt: v("신청일") || page.created_time,
  };
}

async function listApplicants() {
  const t = token();
  const out = [];
  let cursor;
  do {
    const r = await notion
      .call(t, "POST", `/databases/${dbId()}/query`, { page_size: 100, start_cursor: cursor, sorts: [{ timestamp: "created_time", direction: "ascending" }] })
      .catch((e) => {
        if (e.status === 404) throw new Error("체험단 관리 DB를 열 수 없어요. 노션에서 그 DB 페이지 → ··· → 연결 → 성과 통계에 쓰는 통합을 추가해주세요.");
        throw e;
      });
    out.push(...r.results.map(readProps));
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ---- 자동 심사: 신청자 블로그의 최근 활동 ----
function blogIdOf(url) {
  const m = String(url || "").match(/blog\.naver\.com\/(?:PostList\.naver\?blogId=)?([A-Za-z0-9_-]{3,})/);
  return m ? m[1] : null;
}

async function checkBlog(url) {
  const id = blogIdOf(url);
  if (!id) return { ok: false, note: "블로그 주소를 못 읽었어요" };
  try {
    const res = await fetch(`https://rss.blog.naver.com/${id}.xml`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, blogId: id, note: `블로그를 찾을 수 없어요 (HTTP ${res.status})` };
    const xml = await res.text();
    const dates = [...xml.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => new Date(m[1]).getTime()).filter((x) => !isNaN(x));
    const now = Date.now();
    const recent30 = dates.filter((d) => now - d < 30 * 86400000).length;
    // 시계 차이로 방금 쓴 글이 '미래'로 잡힐 수 있어 0일 아래로는 내리지 않는다
    const lastDays = dates.length ? Math.max(0, Math.floor((now - Math.max(...dates)) / 86400000)) : null;
    return { ok: true, blogId: id, recent30, lastDays, total: dates.length, note: dates.length ? "" : "공개된 글이 없어요 (없는 블로그일 수도 있어요)" };
  } catch (e) {
    return { ok: false, blogId: id, note: "블로그 확인 실패: " + e.message };
  }
}

/** 100점 만점: 최근 30일 글 수(최대 60) + 마지막 글이 최근일수록(최대 30) + Windows PC(10) */
function scoreOf(b, windows) {
  if (!b.ok) return 0;
  const posts = Math.min(b.recent30, 15) * 4;
  const recency = b.lastDays == null ? 0 : b.lastDays <= 3 ? 30 : b.lastDays <= 7 ? 22 : b.lastDays <= 14 ? 14 : b.lastDays <= 30 ? 6 : 0;
  return posts + recency + (windows ? 10 : 0);
}

/** 신청자 목록 + 블로그 자동 심사 결과. 점수는 노션 '활동 점수'에도 기록한다 */
async function screen() {
  const list = await listApplicants();
  const t = token();
  for (const a of list) {
    a.blog = await checkBlog(a.blogUrl);
    a.autoScore = scoreOf(a.blog, a.windows);
    if (a.score !== a.autoScore) {
      await notion.call(t, "PATCH", `/pages/${a.id}`, { properties: { "활동 점수": { number: a.autoScore } } }).catch(() => {});
    }
  }
  return list.sort((x, y) => (y.selection === "선정") - (x.selection === "선정") || y.autoScore - x.autoScore);
}

/** 선정: 사용 키 발급 → 노션에 선정·시작일·사용 키 기록 */
async function select(ids, start = license.today()) {
  const t = token();
  const list = await listApplicants();
  const results = [];
  for (const id of ids) {
    const a = list.find((x) => x.id === id);
    if (!a) {
      results.push({ id, error: "신청자를 찾지 못했어요" });
      continue;
    }
    const { key, end } = license.issue({ name: a.name, start, days: TRIAL_DAYS, id: a.id });
    await notion.call(t, "PATCH", `/pages/${a.id}`, {
      properties: {
        선정: { select: { name: "선정" } },
        시작일: { date: { start } },
        "사용 키": { rich_text: [{ type: "text", text: { content: key } }] },
      },
    });
    results.push({ id, name: a.name, contact: a.contact, key, start, end });
  }
  return results;
}

async function setSelection(id, value) {
  await notion.call(token(), "PATCH", `/pages/${id}`, { properties: { 선정: { select: { name: value } } } });
}

module.exports = { listApplicants, screen, select, setSelection, checkBlog, scoreOf, blogIdOf, TRIAL_DAYS };
