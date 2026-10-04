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
  const entry = { pageId: page.id, url: page.url, title: report.title, savedAt: new Date().toISOString(), createdAt: new Date().toISOString(), target: t.title };
  // 나중에 "그 사이 노션에서 직접 고친 구역"을 알아볼 수 있게, 방금 저장된 모습의 구역별 지문을 남긴다
  entry.sectionHashes = await readSectionHashes(c.token, page.id).catch(() => null);
  (log[report.key] ||= []).push(entry);
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

// ---------------------------------------------------------------------------
// 이미 저장한 리포트를 "새 페이지로 또 만들지 않고" 최신 내용으로 고친다.
//  - 페이지를 제목(heading_2) 단위 구역으로 나눠서, 구역마다 새 내용으로 바꾼다
//  - 저장했을 때의 구역 지문과 지금 노션 내용이 다르면 = 사용자가 노션에서 직접 고친 구역 → 그대로 둔다
//  - 새로 생긴 구역은 알맞은 자리에 끼워 넣고, 사용자가 직접 추가한 구역은 건드리지 않는다
// ---------------------------------------------------------------------------
const crypto = require("crypto");
const PLACEHOLDER_REFLECT = "이번 달 가장 잘 된 것 / 아쉬운 것 / 다음 달 집중할 것을 여기에 적어보세요.";
const FOOTER_RE = /블로그 자동화 대시보드에서 .*에 저장/;
const LEAD = "맨 위 요약";

/** 블록 목록 → {lead, sections:[{key, heading, blocks}], tail} (구역 = heading_2부터 다음 heading_2/구분선 전까지) */
function sectionize(blocks) {
  const lead = [];
  const sections = [];
  const tail = [];
  let cur = null;
  let inTail = false;
  for (const b of blocks) {
    if (inTail) { tail.push(b); continue; }
    if (b.type === "divider") { inTail = true; cur = null; tail.push(b); continue; }
    if (b.type === "heading_2") {
      cur = { key: blockText(b).split(" (")[0].trim(), heading: b, blocks: [] };
      sections.push(cur);
      continue;
    }
    (cur ? cur.blocks : lead).push(b);
  }
  return { lead, sections, tail };
}

/** 내용 지문: 글자만 본다(표는 칸 수만). 노션이 읽어온 블록과 우리가 만든 블록 모두 같은 규칙으로 계산한다 */
function hashBlocks(blocks) {
  const lines = blocks.map((b) => `${b.type}|${b.type === "table" ? "w" + ((b.table && b.table.table_width) || 0) : blockText(b)}`);
  return crypto.createHash("sha1").update(lines.join("\n")).digest("hex");
}

function hashesOf(blocks) {
  const { lead, sections } = sectionize(blocks);
  const out = { [LEAD]: hashBlocks(lead) };
  for (const sec of sections) out[sec.key] = hashBlocks(sec.blocks);
  return out;
}

async function readSectionHashes(token, pageId) {
  return hashesOf(await listChildren(token, pageId));
}

const createdIds = (r) => ((r && r.results) || []).map((x) => x.id);

/**
 * 같은 기간 리포트가 이미 노션에 있으면 그 페이지를 최신 내용으로 고친다.
 * @returns null(저장한 적 없음) | {gone:true}(예전 페이지가 지워짐) | {updated:true, replaced, kept, added, unchanged, ...}
 */
async function updateReport(report) {
  const c = getConfig();
  if (!c.token || !c.target) throw new Error("먼저 ⚙️ 노션 설정에서 토큰과 저장 위치를 저장해주세요.");
  const log = getLog();
  const entries = log[report.key] || [];
  const entry = entries[entries.length - 1];
  if (!entry) return null;
  const token = c.token;
  const t = c.target;
  const pageId = entry.pageId;
  const result = { pageId, url: entry.url, title: report.title, updated: true, replaced: [], kept: [], added: [], unchanged: [] };
  try {
    const children = await listChildren(token, pageId);
    const old = sectionize(children);
    const fresh = sectionize(report.blocks);
    const stored = entry.sectionHashes || null; // 없으면(예전에 저장한 페이지) 아래에서 보수적으로 판단한다
    const cur = hashesOf(children);

    // 사용자가 그 구역을 노션에서 직접 고쳤는지: 저장했을 때 지문과 지금 지문이 다르면 고친 것
    const userEdited = (key, blocks) => {
      if (stored && stored[key] !== undefined) return stored[key] !== cur[key];
      // 예전에 저장한 페이지(지문 없음): 사용자가 쓰는 칸(돌아보기)만 placeholder가 아니면 고친 것으로 본다
      if (key.startsWith("🪞")) return blocks.some((b) => blockText(b) && blockText(b) !== PLACEHOLDER_REFLECT);
      return false;
    };

    // (a) 맨 위 요약(글 올린 날·요약 칸): 제목이 없는 구역이라 "예전 맨 위 블록들 바로 뒤에 새로 넣고 예전 것을 지우는" 방식
    if (fresh.lead.length) {
      if (hashBlocks(fresh.lead) === cur[LEAD]) result.unchanged.push(LEAD);
      else if (stored && stored[LEAD] !== undefined && stored[LEAD] !== cur[LEAD]) result.kept.push(LEAD);
      else {
        const after = old.lead.length ? old.lead[old.lead.length - 1].id : null;
        await call(token, "PATCH", `/blocks/${pageId}/children`, { children: fresh.lead, ...(after ? { after } : {}) });
        for (const b of old.lead) await call(token, "DELETE", `/blocks/${b.id}`);
        result.replaced.push(LEAD);
      }
    }

    // (b) 구역별. endId = 지금까지 처리한 마지막 구역의 끝 블록 (새 구역을 끼워 넣을 자리)
    let endId = old.lead.length ? old.lead[old.lead.length - 1].id : null;
    const oldByKey = new Map(old.sections.map((x) => [x.key, x]));
    for (const ns of fresh.sections) {
      const os = oldByKey.get(ns.key);
      if (!os) {
        // 새로 생긴 구역: 앞 구역 바로 뒤에 끼워 넣는다
        const body = { children: [{ object: "block", type: "heading_2", heading_2: ns.heading.heading_2 }, ...ns.blocks], ...(endId ? { after: endId } : {}) };
        const ids = createdIds(await call(token, "PATCH", `/blocks/${pageId}/children`, body));
        if (ids.length) endId = ids[ids.length - 1];
        result.added.push(ns.key);
        continue;
      }
      const osEnd = os.blocks.length ? os.blocks[os.blocks.length - 1].id : os.heading.id;
      if (hashBlocks(ns.blocks) === cur[ns.key]) {
        result.unchanged.push(ns.key);
        endId = osEnd;
      } else if (userEdited(ns.key, os.blocks)) {
        result.kept.push(ns.key); // 사용자가 노션에서 고친 구역은 그대로 둔다
        endId = osEnd;
      } else {
        // 제목 줄도 최신으로(날짜 등), 내용은 새로 넣고 예전 내용은 지운다
        await call(token, "PATCH", `/blocks/${os.heading.id}`, { heading_2: { rich_text: ns.heading.heading_2.rich_text } });
        let lastNew = os.heading.id;
        if (ns.blocks.length) {
          const ids = createdIds(await call(token, "PATCH", `/blocks/${pageId}/children`, { children: ns.blocks, after: os.heading.id }));
          if (ids.length) lastNew = ids[ids.length - 1];
        }
        for (const b of os.blocks) await call(token, "DELETE", `/blocks/${b.id}`);
        result.replaced.push(ns.key);
        endId = lastNew;
      }
    }

    // (c) 맨 아래 "…에 저장" 문구만 최신 시각으로
    const footer = old.tail.find((b) => b.type === "paragraph" && FOOTER_RE.test(blockText(b)));
    const newFooter = fresh.tail.find((b) => b.type === "paragraph" && FOOTER_RE.test(blockText(b)));
    if (footer && newFooter) await call(token, "PATCH", `/blocks/${footer.id}`, { paragraph: { rich_text: newFooter.paragraph.rich_text } });

    // (d) 제목·날짜 속성
    const titleRich = [{ type: "text", text: { content: report.title.slice(0, 2000) } }];
    const properties = t.type === "database" ? { [t.titleProp]: { title: titleRich } } : { title: { title: titleRich } };
    if (t.type === "database" && t.dateProp && report.date) properties[t.dateProp] = { date: { start: report.date.start, end: report.date.end || null } };
    await call(token, "PATCH", `/pages/${pageId}`, { properties });

    // (e) 지금 모습의 지문을 다시 기록한다 (다음에 또 업데이트할 때 "그 사이 직접 고친 곳"을 알아보려고)
    entry.title = report.title;
    entry.savedAt = new Date().toISOString();
    const readBack = await readSectionHashes(token, pageId).catch(() => null);
    const next = { ...(readBack || stored || {}) };
    // 직접 고쳐서 그대로 둔 구역은 "원래 저장됐던 모습"의 지문을 계속 기준으로 삼는다.
    // (지금 모습으로 기준을 바꾸면, 다음 업데이트 때 그 구역을 고친 적 없는 것으로 착각해서 덮어쓰게 된다)
    const freshHash = (key) => (key === LEAD ? hashBlocks(fresh.lead) : hashBlocks((fresh.sections.find((x) => x.key === key) || { blocks: [] }).blocks));
    for (const key of result.kept) next[key] = stored && stored[key] !== undefined ? stored[key] : freshHash(key);
    entry.sectionHashes = next;
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
    return result;
  } catch (e) {
    if (e.status === 404 || e.code === "object_not_found") return { gone: true }; // 예전 페이지가 지워졌다 → 호출한 쪽이 새로 저장한다
    throw new Error(friendlyError(e));
  }
}

function isReady() {
  const c = getConfig();
  return !!(c.token && c.target);
}

module.exports = { getPublicConfig, saveConfig, saveReport, updateReport, getLog, parseNotionId, replaceSection, isReady, call, getConfig, sectionize, hashBlocks };
