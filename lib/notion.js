// 노션 저장: 사용자가 설정한 "통합 토큰 + 저장 위치(페이지 또는 데이터베이스 링크)"에 리포트를 만든다.
// 사람마다 자기 토큰/위치를 넣어서 쓰는 구조 (로컬 data/notion-config.json 에만 저장).
const path = require("path");
const fs = require("fs");

const CONFIG_PATH = path.join(__dirname, "..", "data", "notion-config.json");
const LOG_PATH = path.join(__dirname, "..", "data", "notion-log.json");
const API = process.env.NOTION_API_BASE || "https://api.notion.com/v1"; // 테스트용으로만 바꿈
const NOTION_VERSION = "2022-06-28";

const readJson = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fb;
  }
};

function getConfig() {
  return readJson(CONFIG_PATH, {});
}

/** 화면에 돌려줄 때는 토큰을 가린다 */
function getPublicConfig() {
  const c = getConfig();
  return {
    hasToken: !!c.token,
    tokenHint: c.token ? `${c.token.slice(0, 7)}…${c.token.slice(-4)}` : "",
    targetUrl: c.targetUrl || "",
    target: c.target || null, // {type, id, title}
  };
}

/** 노션 링크에서 32자리 id 추출 (하이픈 있어도/없어도) */
function parseNotionId(input) {
  const s = String(input || "").trim();
  const clean = s.split("?")[0].split("#")[0];
  // 링크 마지막 부분이 "제목-<32자리id>" 형태라, 16진수 덩어리 중 마지막 것의 끝 32자리를 쓴다
  // (제목이 cafe 처럼 16진수 글자로 끝나도 안전)
  const runs = clean.replace(/-/g, "").match(/[0-9a-f]{32,}/gi);
  if (!runs) return null;
  const h = runs[runs.length - 1].slice(-32).toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function call(token, method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || `Notion API ${res.status}`);
    err.status = res.status;
    err.code = json.code;
    throw err;
  }
  return json;
}

const plain = (rich) => (rich || []).map((r) => r.plain_text).join("");

/** 저장 위치가 페이지인지 데이터베이스인지 확인하고 이름을 가져온다 */
async function resolveTarget(token, id) {
  try {
    const db = await call(token, "GET", `/databases/${id}`);
    const titleProp = Object.entries(db.properties).find(([, p]) => p.type === "title");
    const dateProp = Object.entries(db.properties).find(([, p]) => p.type === "date");
    return { type: "database", id, title: plain(db.title) || "(제목 없는 데이터베이스)", titleProp: titleProp && titleProp[0], dateProp: dateProp && dateProp[0], url: db.url };
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }
  const page = await call(token, "GET", `/pages/${id}`);
  const t = Object.values(page.properties || {}).find((p) => p.type === "title");
  return { type: "page", id, title: (t && plain(t.title)) || "(제목 없는 페이지)", url: page.url };
}

/**
 * 이 토큰으로 실제 접근 가능한 페이지·데이터베이스 목록 (검색 API).
 * "저장 위치를 찾을 수 없어요" 에러 옆에 같이 보여줘서, 워크스페이스가 다른지/연결이 안 됐는지
 * 사용자가 직접 눈으로 비교해서 알 수 있게 한다.
 */
async function listAccessible(token) {
  try {
    const r = await call(token, "POST", "/search", { page_size: 20, sort: { direction: "descending", timestamp: "last_edited_time" } });
    return r.results.map((o) => {
      const titleProp = o.object === "database" ? o.title : Object.values(o.properties || {}).find((p) => p.type === "title");
      return { type: o.object, title: plain(Array.isArray(titleProp) ? titleProp : (titleProp && titleProp.title)) || "(제목 없음)", url: o.url };
    });
  } catch {
    return null;
  }
}

function friendlyError(e) {
  if (e.status === 401) return "토큰이 올바르지 않아요. 노션 통합의 '내부 통합 시크릿'을 다시 복사해 넣어주세요.";
  if (e.status === 404 || e.code === "object_not_found")
    return "저장 위치를 찾을 수 없어요. 링크가 맞는지, 그리고 그 페이지에서 ··· → 연결(Connections) → 내 통합을 추가했는지 확인해주세요.";
  if (e.status === 403) return "이 통합에 쓰기 권한이 없어요. 통합 설정의 '기능'에서 콘텐츠 입력 권한을 켜주세요.";
  if (e.status === 429) return "노션 요청이 너무 많아요. 잠시 후 다시 시도해주세요.";
  return e.message;
}

/** 설정 저장 + 연결 테스트 (토큰을 비워 보내면 기존 토큰 유지) */
async function saveConfig({ token, targetUrl }) {
  const cur = getConfig();
  const tk = (token || "").trim() || cur.token;
  if (!tk) throw new Error("노션 통합 토큰을 입력해주세요.");
  const id = parseNotionId(targetUrl);
  if (!id) throw new Error("노션 페이지/데이터베이스 링크에서 ID를 찾지 못했어요. 브라우저 주소창의 링크를 그대로 붙여넣어 주세요.");
  let target;
  try {
    target = await resolveTarget(tk, id);
  } catch (e) {
    const err = new Error(friendlyError(e));
    if (e.status === 404 || e.code === "object_not_found") err.accessible = await listAccessible(tk);
    throw err;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ token: tk, targetUrl: targetUrl.trim(), target, savedAt: new Date().toISOString() }, null, 2));
  return getPublicConfig();
}

function getLog() {
  return readJson(LOG_PATH, {});
}

/**
 * 리포트 저장. report = { key, title, date, blocks }
 * 블록은 한 번에 100개까지만 보낼 수 있어서 나눠서 붙인다.
 */
async function saveReport(report) {
  const c = getConfig();
  if (!c.token || !c.target) throw new Error("먼저 ⚙️ 노션 설정에서 토큰과 저장 위치를 저장해주세요.");
  const t = c.target;
  const first = report.blocks.slice(0, 100);
  const rest = report.blocks.slice(100);
  const titleRich = [{ type: "text", text: { content: report.title.slice(0, 2000) } }];

  let page;
  try {
    if (t.type === "database") {
      const properties = { [t.titleProp]: { title: titleRich } };
      if (t.dateProp && report.date) properties[t.dateProp] = { date: { start: report.date.start, end: report.date.end || null } };
      page = await call(c.token, "POST", "/pages", { parent: { database_id: t.id }, icon: { type: "emoji", emoji: report.icon || "📊" }, properties, children: first });
    } else {
      page = await call(c.token, "POST", "/pages", { parent: { page_id: t.id }, icon: { type: "emoji", emoji: report.icon || "📊" }, properties: { title: { title: titleRich } }, children: first });
    }
    for (let i = 0; i < rest.length; i += 100) {
      await call(c.token, "PATCH", `/blocks/${page.id}/children`, { children: rest.slice(i, i + 100) });
    }
  } catch (e) {
    throw new Error(friendlyError(e));
  }

  const log = getLog();
  (log[report.key] ||= []).push({ pageId: page.id, url: page.url, title: report.title, savedAt: new Date().toISOString(), target: t.title });
  fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  return { pageId: page.id, url: page.url, title: report.title, target: t.title };
}

async function listChildren(token, blockId) {
  const out = [];
  let cursor;
  do {
    const q = cursor ? `?page_size=100&start_cursor=${cursor}` : "?page_size=100";
    const r = await call(token, "GET", `/blocks/${blockId}/children${q}`);
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}

const blockText = (b) => ((b[b.type] && b[b.type].rich_text) || []).map((r) => r.plain_text || (r.text && r.text.content) || "").join("");

/**
 * 이미 저장된 리포트 페이지에서 heading_2 "✍️ 회고..." 섹션의 내용만 새 블록으로 바꾼다.
 * (섹션 = 그 제목 다음부터 다음 heading_2 / 구분선 전까지. 페이지의 다른 부분은 건드리지 않음)
 * 섹션이 없으면 페이지 끝에 제목과 함께 붙인다.
 */
async function replaceSection(pageId, headingPrefix, newBlocks, headingBlock) {
  const c = getConfig();
  if (!c.token) throw new Error("노션 토큰이 없어요.");
  try {
    const children = await listChildren(c.token, pageId);
    const hi = children.findIndex((b) => b.type === "heading_2" && blockText(b).startsWith(headingPrefix));
    if (hi < 0) {
      await call(c.token, "PATCH", `/blocks/${pageId}/children`, { children: [headingBlock, ...newBlocks] });
      return "appended";
    }
    const old = [];
    for (let i = hi + 1; i < children.length; i++) {
      const b = children[i];
      if (b.type === "heading_2" || b.type === "divider") break;
      old.push(b);
    }
    // 새 내용을 제목 바로 뒤에 넣고, 예전 내용은 지운다 (노션 휴지통으로 이동)
    await call(c.token, "PATCH", `/blocks/${pageId}/children`, { children: newBlocks, after: children[hi].id });
    for (const b of old) await call(c.token, "DELETE", `/blocks/${b.id}`);
    return "replaced";
  } catch (e) {
    if (e.status === 404 || e.code === "object_not_found") {
      const err = new Error("예전에 저장한 노션 페이지를 찾을 수 없어요 (삭제됐거나 연결이 끊겼어요).");
      err.pageGone = true;
      throw err;
    }
    throw new Error(friendlyError(e));
  }
}

function isReady() {
  const c = getConfig();
  return !!(c.token && c.target);
}

module.exports = { getPublicConfig, saveConfig, saveReport, getLog, parseNotionId, replaceSection, isReady };
