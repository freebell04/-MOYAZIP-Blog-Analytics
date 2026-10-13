// 성과 통계 > 🗓 발행 기록: 내 블로그에 지금까지 올린 글의 날짜 목록.
// 네이버 모바일 글 목록(로그인 없이 공개 글만)을 30개씩 끝까지 넘겨 읽는다. 크롬 창을 열지 않는다.
// 30분 동안은 다시 읽지 않고, 파일에도 저장해 둔다 (프로그램을 다시 켜도 바로 보이게).
const path = require("path");
const fs = require("fs");

const SAVE_PATH = path.join(__dirname, "..", "data", "post-log.json");
const FRESH_MS = 30 * 60 * 1000;
let mem = null;

const kstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const kstTime = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(11, 16);

async function fetchPage(blogId, page) {
  const r = await fetch(`https://m.blog.naver.com/api/blogs/${blogId}/post-list?categoryNo=0&itemCount=30&page=${page}`, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://m.blog.naver.com/" },
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  return (j && j.result && j.result.items) || [];
}

async function load(blogId, { refresh = false } = {}) {
  if (!blogId) throw new Error("블로그 아이디가 설정되어 있지 않아요.");
  if (!mem) { try { mem = JSON.parse(fs.readFileSync(SAVE_PATH, "utf-8")); } catch {} }
  if (!refresh && mem && mem.blogId === blogId && Date.now() - new Date(mem.updatedAt).getTime() < FRESH_MS) return mem;
  const posts = [];
  const seen = new Set();
  for (let page = 1; page <= 60; page++) {
    const items = await fetchPage(blogId, page);
    for (const it of items) {
      const logNo = String(it.logNo);
      if (seen.has(logNo) || !it.addDate) continue;
      seen.add(logNo);
      posts.push({ logNo, title: String(it.titleWithInspectMessage || it.title || "").replace(/<[^>]+>/g, "").trim(), day: kstDay(it.addDate), time: kstTime(it.addDate), link: `https://blog.naver.com/${blogId}/${logNo}` });
    }
    if (items.length < 30) break;
  }
  posts.sort((a, b) => (a.day + a.time).localeCompare(b.day + b.time));
  mem = { blogId, updatedAt: new Date().toISOString(), posts };
  try { fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true }); fs.writeFileSync(SAVE_PATH, JSON.stringify(mem)); } catch {}
  return mem;
}

module.exports = { load };
