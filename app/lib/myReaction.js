// 이웃의 최신 글에 "내가 이미 공감했거나 댓글을 남겼는지" 확인한다 (프로그램 밖에서 네이버에서 직접 한 것도 알아내기 위해).
//  - 공감: 네이버 공감 서비스에 로그인 쿠키로 물으면 내가 눌렀는지(isReacted)를 알려준다
//  - 댓글: 그 글의 댓글 목록에 내 아이디가 있는지
// 로그인 쿠키는 이 프로그램이 저장해 둔 네이버 로그인 정보(data/session)를 쓰고, 크롬을 켜지 않는다.
const path = require("path");
const fs = require("fs");

const SESSION_PATH = path.join(__dirname, "..", "data", "session", "naver-state.json");
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";
const RECHECK_MS = 5 * 60 * 1000; // 아직 아무것도 안 했다고 나온 글은 5분 뒤에 다시 확인한다 (한 것으로 나온 건 다시 안 본다)

const cache = new Map(); // "blogId:logNo" -> {liked, commented, at}
const blogNoCache = new Map(); // blogId -> blogNo

function cookieHeader() {
  try {
    const st = JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"));
    return (st.cookies || []).filter((c) => /naver\.com$/.test(String(c.domain || "").replace(/^\./, ""))).map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

const stripJsonp = (t) => JSON.parse(String(t).replace(/^[^(]*\(/, "").replace(/\);?\s*$/, ""));

async function liked(cookie, blogId, logNo) {
  const url = `https://blog.like.naver.com/v1/search/contents?suppress_response_codes=true&callback=cb&q=BLOG%5B${blogId}_${logNo}%5D&isDuplication=true`;
  const r = await fetch(url, { headers: { cookie, referer: `https://m.blog.naver.com/${blogId}/${logNo}`, "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  const j = stripJsonp(await r.text());
  return (j.contents || []).some((c) => (c.reactions || []).some((x) => x.isReacted));
}

async function blogNoOf(cookie, blogId) {
  if (blogNoCache.has(blogId)) return blogNoCache.get(blogId);
  const r = await fetch(`https://m.blog.naver.com/api/blogs/${blogId}`, { headers: { cookie, referer: "https://m.blog.naver.com/", "user-agent": UA }, signal: AbortSignal.timeout(8000) });
  const m = (await r.text()).match(/"blogNo"\s*:\s*"?(\d+)/);
  const n = m ? m[1] : "";
  if (n) blogNoCache.set(blogId, n);
  return n;
}

async function commented(cookie, blogId, logNo, myId) {
  const blogNo = await blogNoOf(cookie, blogId);
  if (!blogNo) return false;
  for (let page = 1; page <= 3; page++) {
    const url =
      "https://apis.naver.com/commentBox/cbox/web_naver_list_jsonp.json?ticket=blog&templateId=default&pool=blogid&lang=ko&country=" +
      `&objectId=${blogNo}_201_${logNo}&groupId=${blogNo}&pageSize=50&indexSize=10&page=${page}&sort=NEW&_callback=cb`;
    const r = await fetch(url, { headers: { referer: `https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}`, "user-agent": UA }, signal: AbortSignal.timeout(8000) });
    const j = stripJsonp(await r.text());
    const list = (j.result && j.result.commentList) || [];
    if (list.some((c) => !c.deleted && c.profileUserId === myId)) return true;
    if (list.length < 50) return false;
  }
  return false;
}

/** posts: [{blogId, logNo}] → { "blogId:logNo": {liked, commented} } (확인에 실패한 글은 결과에서 뺀다) */
async function check(posts, myId) {
  const cookie = cookieHeader();
  if (!cookie) throw new Error("네이버 로그인 정보가 없어요. 먼저 로그인해주세요.");
  const out = {};
  const todo = [];
  for (const p of posts.slice(0, 150)) {
    if (!/^[\w-]+$/.test(String(p.blogId || "")) || !/^\d+$/.test(String(p.logNo || ""))) continue;
    const key = `${p.blogId}:${p.logNo}`;
    const c = cache.get(key);
    if (c && (c.liked || c.commented || Date.now() - c.at < RECHECK_MS)) out[key] = { liked: c.liked, commented: c.commented };
    else todo.push(p);
  }
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const p = todo[next++];
      const key = `${p.blogId}:${p.logNo}`;
      try {
        const [l, c] = await Promise.all([liked(cookie, p.blogId, p.logNo), commented(cookie, p.blogId, p.logNo, myId)]);
        cache.set(key, { liked: l, commented: c, at: Date.now() });
        out[key] = { liked: l, commented: c };
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  return out;
}

module.exports = { check };
