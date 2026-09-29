// 이웃 소통 도우미: 내 글에 공감/댓글 남긴 사람, 이웃 목록, 답글 안 단 댓글을 한 번에 모은다.
//
// - 내 글 목록 / 이웃의 최신 글: RSS (로그인 불필요)
// - 댓글: 네이버 댓글 API (로그인 불필요)
// - 공감한 사람, 이웃 목록: 로그인 필요. headless + 저장 쿠키로는 서버가 로그아웃으로 보는 경우가 있어,
//   실제 로그인에 쓰는 디버그 크롬(CDP)의 페이지 안에서 가져온다.
// 공감/댓글/이웃추가를 "누르는" 기능은 일부러 없다 — 행동은 사용자가 직접 한다.
const path = require("path");
const fs = require("fs");
const session = require("./session");

const BLOG_ID = require("./config").blogId();
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_PATH = path.join(DATA_DIR, "neighbors.json");
const VISITED_PATH = path.join(DATA_DIR, "neighbors-visited.json");
const SEEN_PATH = path.join(DATA_DIR, "neighbors-seen.json");
const BASELINE_NEW_COUNT = 5; // 첫 실행 때 "나를 추가한" 목록 맨 위(최근 추가순) 몇 명을 새 친구로 볼지

/**
 * 사람마다 처음 본 날짜를 기록해서 "새로운 친구"를 알아낸다.
 * 네이버가 이웃 추가 날짜를 안 알려줘서, 새로 불러올 때마다 목록을 비교하는 방식.
 * 첫 실행이면 기존 사람들은 모두 예전부터 알던 사람으로 두고,
 * "나를 추가한" 목록(최근 추가순) 맨 위 몇 명만 새 친구로 본다.
 */
function updateSeen(neighbors, addedMeOrder) {
  const seen = readJson(SEEN_PATH, null);
  const now = new Date().toISOString();
  const next = seen || {};
  if (!seen) {
    const recent = new Set(addedMeOrder.slice(0, BASELINE_NEW_COUNT));
    for (const n of neighbors) next[n.blogId] = recent.has(n.blogId) ? now : "baseline";
  } else {
    for (const n of neighbors) if (!next[n.blogId]) next[n.blogId] = now;
  }
  fs.writeFileSync(SEEN_PATH, JSON.stringify(next, null, 2));
  for (const n of neighbors) n.firstSeen = next[n.blogId] === "baseline" ? null : next[n.blogId];
}
const REQUEST_GAP_MS = 800; // 네이버에 부담 안 주도록 요청 사이 간격

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** RSS에서 글 목록을 가져온다. [{logNo, title, link, date}] */
async function fetchRss(blogId) {
  const res = await fetch(`https://rss.blog.naver.com/${blogId}.xml`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`RSS ${blogId}: HTTP ${res.status}`);
  const xml = await res.text();
  const tag = (s, k) => {
    const m = s.match(new RegExp(`<${k}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${k}>`));
    return m ? decodeEntities(m[1].trim()) : "";
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const link = tag(m[1], "link").replace(/\?.*$/, "");
    return {
      logNo: (link.match(/\/(\d+)$/) || [])[1],
      title: tag(m[1], "title"),
      link,
      date: new Date(tag(m[1], "pubDate")).toISOString(),
    };
  });
}

async function fetchBlogNo(blogId, logNo) {
  const html = await (await fetch(`https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}`)).text();
  const blogNo = (html.match(/blogNo\s*[=:]\s*['"]?(\d+)/) || [])[1];
  if (!blogNo) throw new Error("blogNo를 찾지 못했습니다.");
  return blogNo;
}

/** 글 하나의 댓글 전체(답글, 내 댓글 포함). */
async function fetchComments(blogNo, logNo) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const url =
      "https://apis.naver.com/commentBox/cbox/web_naver_list_jsonp.json?ticket=blog&templateId=default&pool=blogid&lang=ko&country=" +
      `&objectId=${blogNo}_201_${logNo}&groupId=${blogNo}&pageSize=50&indexSize=10&page=${page}&sort=NEW&_callback=cb`;
    const res = await fetch(url, {
      headers: { referer: `https://blog.naver.com/PostView.naver?blogId=${BLOG_ID}&logNo=${logNo}` },
    });
    const text = await res.text();
    const json = JSON.parse(text.replace(/^[^(]*\(/, "").replace(/\);?\s*$/, ""));
    if (!json.success) throw new Error("댓글 API 실패: " + (json.message || "unknown"));
    for (const c of (json.result && json.result.commentList) || []) {
      if (!c.profileUserId || c.deleted) continue;
      out.push({
        no: c.commentNo,
        parentNo: c.parentCommentNo || c.commentNo,
        blogId: c.profileUserId,
        nickname: c.userName,
        profileImage: c.userProfileImage || "",
        text: decodeEntities(c.contents),
        date: c.regTime,
      });
    }
    const pageModel = json.result && json.result.pageModel;
    if (!pageModel || page >= (pageModel.lastPage || 1)) break;
    await sleep(REQUEST_GAP_MS);
  }
  return out;
}

/**
 * 댓글 스레드(원댓글 + 답글)별로 마지막 말을 내가 안 했으면 "답글 필요".
 * 스티커만 단 경우 등 텍스트가 없어도 포함한다.
 */
function findUnanswered(comments) {
  const threads = {};
  for (const c of comments) (threads[c.parentNo] ||= []).push(c);
  const out = [];
  for (const list of Object.values(threads)) {
    list.sort((a, b) => new Date(a.date) - new Date(b.date));
    const last = list[list.length - 1];
    if (last.blogId === BLOG_ID) continue;
    const root = list.find((c) => c.no === c.parentNo) || list[0];
    out.push({ blogId: last.blogId, nickname: last.nickname, text: last.text, date: last.date, rootText: root !== last ? root.text : null });
  }
  return out;
}

// 로그인된 m.blog 페이지 안에서 JSON API 호출
function pageFetchJson(page, url) {
  return page.evaluate(async (u) => (await fetch(u, { credentials: "include" })).json(), url);
}

/**
 * 공감한 사람 목록.
 * relationType: BOTH_NEIGHBOR(서로이웃) / NEIGHBOR(내가 추가한 이웃) / LOGIN_USER(이웃 아님)
 */
async function fetchSympathies(page, logNo) {
  const users = [];
  // 네이버 모바일 공감 목록 화면과 같은 파라미터 (categoryId/itemCount/timeStamp 없으면 목록이 비어서 온다)
  let timeStamp = Date.now();
  for (let i = 0; i < 20; i++) {
    const json = await pageFetchJson(
      page,
      `/api/blogs/${BLOG_ID}/posts/${logNo}/sympathy-users?categoryId=POST&itemCount=100&timeStamp=${timeStamp}`
    );
    const result = json && json.result;
    if (!result) throw new Error("공감 API 오류: " + ((json && json.error && json.error.message) || "응답 없음"));
    for (const u of result.sympathyUserViewList || []) {
      if (!u.userId || u.userId === BLOG_ID || u.deletedBlog) continue;
      users.push({
        blogId: u.userId,
        nickname: u.userNickName || u.userBlogName || u.userId,
        profileImage: u.profileImageURL || "",
        date: u.addDate ? new Date(u.addDate / 1000).toISOString() : null, // addDate는 마이크로초
      });
    }
    if (!result.nextTimeStamp || result.nextTimeStamp === -1) break;
    timeStamp = result.nextTimeStamp;
    await sleep(REQUEST_GAP_MS);
  }
  return users;
}

/**
 * 모바일 이웃목록 화면을 끝까지 스크롤해서 읽는다 (목록 API가 따로 노출되지 않아 DOM에서 읽음).
 * listType: "" = 내가 추가한, "addedList" = 나를 추가한
 * 버튼 문구: 서로이웃 / 이웃 / 이웃추가(= 내가 아직 추가 안 함)
 */
async function fetchBuddyList(page, listType) {
  const qs = listType ? `&listType=${listType}` : "";
  await page.goto(`https://m.blog.naver.com/BuddyList.naver?blogId=${BLOG_ID}${qs}`, { waitUntil: "networkidle" });
  await page.bringToFront().catch(() => {}); // 뒤에 있는 탭이면 무한스크롤이 안 불러와지는 경우가 있음
  // 화면 위의 "46명" 숫자만큼 불러올 때까지 스크롤 (숫자를 못 읽으면 개수가 3번 연속 그대로일 때 멈춤)
  const expected = await page
    .evaluate(() => {
      const m = document.body.innerText.match(/(\d+)\s*명/);
      return m ? Number(m[1]) : 0;
    })
    .catch(() => 0);
  let prev = -1;
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    const n = await page.$$eval('[class^="buddy_item"]', (els) => els.length);
    if (expected && n >= expected) break;
    stable = n === prev ? stable + 1 : 0;
    if (stable >= 3) break;
    prev = n;
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(800);
  }
  return page.$$eval('[class^="buddy_item"]', (els) =>
    els
      .map((el) => {
        const a = el.querySelector("a[href*='blogId=']");
        const blogId = a && new URL(a.href).searchParams.get("blogId");
        const q = (sel) => (el.querySelector(sel) || {}).innerText || "";
        const img = el.querySelector("img");
        return {
          blogId,
          nickname: q('[class^="name"]').trim(),
          blogName: q('[class^="desc"]').trim(),
          profileImage: img ? img.src : "",
          button: q('[class^="buddy_set_wrap"] button').trim(),
        };
      })
      .filter((b) => b.blogId)
  );
}

/**
 * 이웃의 글 목록을 병렬(동시 4개)로 가져온다.
 * result[id] = { latest, recent } — recent는 최근 30일 글 최대 10개
 */
async function fetchLatestPosts(blogIds, onProgress) {
  const result = {};
  let i = 0;
  let done = 0;
  const worker = async () => {
    while (i < blogIds.length) {
      const id = blogIds[i++];
      try {
        const items = await fetchRss(id);
        const since = Date.now() - 30 * 86400000;
        result[id] = {
          latest: items[0] || null,
          recent: items.filter((p) => new Date(p.date).getTime() >= since).slice(0, 10).map(({ title, link, date }) => ({ title, link, date })),
        };
      } catch {
        result[id] = { latest: null, recent: [] };
      }
      onProgress(++done, blogIds.length);
      await sleep(200);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return result;
}

let refreshState = { running: false, progress: "", error: null, needLogin: false };

function getRefreshState() {
  return refreshState;
}

/**
 * 최근 글들을 돌면서 "최근 N일 안에" 달린 공감/댓글을 모으고, 이웃 목록과 합쳐 캐시에 저장한다.
 * (옛날 글에 오늘 달린 공감도 잡히도록, 기간은 글 작성일이 아니라 공감/댓글 시점 기준)
 * 오래 걸리므로 백그라운드로 돌리고 진행 상황은 getRefreshState()로 본다.
 */
async function refresh({ days = 7, postDays = 30, maxPosts = 15 } = {}) {
  if (refreshState.running) return;
  refreshState = { running: true, progress: "로그인 확인 중...", error: null, needLogin: false };

  let browser, page;
  try {
    const ctx = await session.openVisibleContext();
    browser = ctx.browser;
    page = await ctx.context.newPage();

    await page.goto(`https://m.blog.naver.com/${BLOG_ID}`, { waitUntil: "domcontentloaded" });
    const me = await pageFetchJson(page, "/api/current-user").catch(() => null);
    if (!me || !me.result || !me.result.loggedIn || me.result.userId !== BLOG_ID) {
      await page.close().catch(() => {});
      refreshState = { running: false, progress: "", error: "네이버에 로그인되어 있지 않아요. [네이버 로그인]을 눌러 크롬에서 로그인한 뒤 다시 불러와주세요.", needLogin: true };
      return;
    }

    refreshState.progress = "내 글 목록 가져오는 중...";
    const since = Date.now() - days * 24 * 3600 * 1000;
    const inRange = (d) => !d || new Date(d).getTime() >= since;
    const postSince = Date.now() - Math.max(days, postDays) * 24 * 3600 * 1000;
    const allPosts = await fetchRss(BLOG_ID);
    const posts = allPosts.filter((p) => new Date(p.date).getTime() >= postSince).slice(0, maxPosts);
    if (!posts.length) throw new Error(`최근 ${postDays}일 동안 쓴 글이 없습니다.`);
    const blogNo = await fetchBlogNo(BLOG_ID, posts[0].logNo);

    const people = {}; // blogId -> person (최근 N일 안에 공감/댓글 준 사람)
    const person = (blogId, nickname) =>
      (people[blogId] ||= { blogId, nickname, profileImage: "", likes: [], comments: [] });
    const postStats = [];
    const myComments = []; // 추천 댓글 만들 때 참고할 내 말투 샘플
    const unanswered = [];

    for (const [i, post] of posts.entries()) {
      refreshState.progress = `공감·댓글 확인 중 (${i + 1}/${posts.length}) ${post.title}`;
      const postRef = { logNo: post.logNo, title: post.title };

      const likes = await fetchSympathies(page, post.logNo);
      for (const u of likes) {
        if (!inRange(u.date)) continue;
        const p = person(u.blogId, u.nickname);
        p.profileImage ||= u.profileImage;
        p.likes.push({ ...postRef, date: u.date });
      }
      await sleep(REQUEST_GAP_MS);

      const comments = await fetchComments(blogNo, post.logNo);
      for (const c of comments) {
        if (c.blogId === BLOG_ID) {
          if (c.text.trim()) myComments.push({ text: c.text, date: c.date });
          continue;
        }
        if (!inRange(c.date)) continue;
        const p = person(c.blogId, c.nickname);
        p.profileImage ||= c.profileImage;
        p.comments.push({ ...postRef, text: c.text, date: c.date });
      }
      const open = findUnanswered(comments).map((u) => ({ ...u, ...postRef }));
      unanswered.push(...open);
      postStats.push({
        ...postRef,
        link: post.link,
        date: post.date,
        likeCount: likes.length,
        commentCount: comments.filter((c) => c.blogId !== BLOG_ID).length,
        unansweredCount: open.length,
      });
      await sleep(REQUEST_GAP_MS);
    }

    refreshState.progress = "이웃 목록 가져오는 중 (내가 추가한)...";
    const myAdded = await fetchBuddyList(page, "");
    refreshState.progress = "이웃 목록 가져오는 중 (나를 추가한)...";
    const addedMe = await fetchBuddyList(page, "addedList");
    await page.close().catch(() => {});

    // 이웃 목록(내가 추가 ∪ 나를 추가 ∪ 최근 소통한 사람)으로 합친다
    const neighbors = {};
    const nb = (blogId) => (neighbors[blogId] ||= { blogId, iAdded: false, addedMe: false, mutual: false });
    for (const b of myAdded) Object.assign(nb(b.blogId), { nickname: b.nickname, blogName: b.blogName, profileImage: b.profileImage, iAdded: true, mutual: b.button === "서로이웃" });
    for (const [i, b] of addedMe.entries()) {
      const n = nb(b.blogId);
      n.addedMe = true;
      n.addedMeOrder = i; // 0 = 가장 최근에 나를 추가한 사람
      if (b.button === "서로이웃") n.mutual = true;
      if (b.button === "서로이웃" || b.button === "이웃") n.iAdded = true;
      n.nickname ||= b.nickname;
      n.blogName ||= b.blogName;
      n.profileImage ||= b.profileImage;
    }
    for (const p of Object.values(people)) {
      const n = nb(p.blogId);
      n.nickname ||= p.nickname;
      n.profileImage ||= p.profileImage;
    }
    for (const n of Object.values(neighbors)) {
      const p = people[n.blogId];
      n.likeCount = p ? p.likes.length : 0;
      n.commentCount = p ? p.comments.length : 0;
      if (p && !p.profileImage) p.profileImage = n.profileImage;
      if (p) p.relation = n.mutual ? "mutual" : n.iAdded ? "iAdded" : n.addedMe ? "addedMe" : "none";
    }

    // 최신 글: 이웃 목록 전체 (내가 추가 + 나를 추가 + 최근 소통한 사람) — 답방 목록에 모두 보여주기 위해
    const ids = Object.keys(neighbors);
    const latest = await fetchLatestPosts(ids, (d, t) => (refreshState.progress = `이웃 최신 글 확인 중 (${d}/${t})`));
    for (const id of ids) {
      neighbors[id].latestPost = latest[id].latest;
      neighbors[id].recentPosts = latest[id].recent;
      if (people[id]) people[id].latestPost = latest[id].latest;
    }

    updateSeen(Object.values(neighbors), addedMe.map((b) => b.blogId));

    const cache = {
      updatedAt: new Date().toISOString(),
      days,
      lastPostDate: allPosts[0] ? allPosts[0].date : null,
      posts: postStats,
      people: Object.values(people),
      neighbors: Object.values(neighbors),
      unanswered: unanswered.sort((a, b) => new Date(b.date) - new Date(a.date)),
      myComments: myComments.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20).map((c) => c.text),
    };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
    refreshState = { running: false, progress: "완료", error: null, needLogin: false };
  } catch (e) {
    refreshState = { running: false, progress: "", error: e.message, needLogin: false };
  } finally {
    if (page) await page.close().catch(() => {}); // 사용자 크롬에 탭이 남지 않게
    if (browser) await browser.close().catch(() => {});
  }
}

function getCached() {
  return readJson(CACHE_PATH, null);
}

/** 답방 체크: { "<blogId>": "<latestPost.logNo>" } — 새 글이 올라오면 자동으로 다시 '할 일'이 된다. */
function getVisited() {
  return readJson(VISITED_PATH, {});
}

function setVisited(blogId, logNo, done) {
  const visited = getVisited();
  if (done) visited[blogId] = logNo;
  else delete visited[blogId];
  fs.writeFileSync(VISITED_PATH, JSON.stringify(visited, null, 2));
  return visited;
}

module.exports = { BLOG_ID, refresh, getRefreshState, getCached, getVisited, setVisited, fetchSympathies, fetchComments, fetchBlogNo };
