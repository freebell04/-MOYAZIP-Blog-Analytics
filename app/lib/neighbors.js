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
const BUDDY_FRESH_MS = 15 * 60 * 1000; // 이웃 목록을 다시 읽지 않고 쓰는 시간 (15분)
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
const REQUEST_GAP_MS = 150; // 같은 목록의 다음 페이지를 넘길 때만 쓰는 짧은 간격 (글마다 쉬던 간격은 없앴다)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 일시적인 실패(순간적인 네트워크 오류·네이버의 일시 제한)는 잠깐 쉬었다가 다시 시도한다 (최대 3번) */
async function withRetry(fn, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await sleep(400 * (i + 1));
    }
  }
  throw lastErr;
}

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
  await page.goto(`https://m.blog.naver.com/BuddyList.naver?blogId=${BLOG_ID}${qs}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[class^="buddy_item"]', { timeout: 8000 }).catch(() => {}); // 첫 항목이 보이면 바로 시작 (네트워크가 잠잠해질 때까지 기다리지 않는다)
  await page.bringToFront().catch(() => {}); // 뒤에 있는 탭이면 무한스크롤이 안 불러와지는 경우가 있음
  // 화면 위의 "46명" 숫자만큼 불러올 때까지 스크롤 (숫자를 못 읽으면 개수가 3번 연속 그대로일 때 멈춤)
  const expected = await page
    .evaluate(() => {
      const m = document.body.innerText.match(/(\d+)\s*명/);
      return m ? Number(m[1]) : 0;
    })
    .catch(() => 0);
  const countItems = () => page.$$eval('[class^="buddy_item"]', (els) => els.length);
  let stable = 0;
  for (let i = 0; i < 60; i++) {
    const n = await countItems();
    if (expected && n >= expected) break;
    if (stable >= 3) break; // 스크롤해도 개수가 3번 연속 그대로면 끝까지 온 것
    await page.evaluate(() => window.scrollTo(0, document.scrollingElement.scrollHeight));
    await page.mouse.wheel(0, 3000);
    // 고정으로 0.8초 기다리지 않고, 항목이 늘어나는 순간 바로 다음으로 (최대 1.2초)
    let grew = false;
    for (let w = 0; w < 12; w++) {
      await page.waitForTimeout(100);
      if ((await countItems()) > n) { grew = true; break; }
    }
    stable = grew ? 0 : stable + 1;
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
 * 이웃의 글 목록을 병렬(동시 10개)로 가져온다.
 * result[id] = { latest, recent } — recent는 최근 30일 글 최대 10개
 */
async function fetchLatestPosts(blogIds, onProgress = () => {}) {
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
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, Math.max(1, blogIds.length)) }, worker)); // 동시에 10개씩
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
async function refresh({ days = 7, postDays = 30, maxPosts = 15, full = false } = {}) {
  if (refreshState.running) return;
  const t0 = Date.now();
  refreshState = { running: true, progress: "로그인 확인 중...", error: null, needLogin: false };

  let browser, page, buddyPage;
  try {
    // 이웃 목록(누가 이웃인지)은 자주 안 바뀌니, 15분 안에 읽은 게 있으면 다시 읽지 않고 그대로 쓴다. (full이면 항상 새로 읽음)
    const cache = full ? null : getCached();
    const listFresh = !!(cache && Array.isArray(cache.neighbors) && cache.neighbors.length && cache.buddyUpdatedAt && Date.now() - new Date(cache.buddyUpdatedAt).getTime() < BUDDY_FRESH_MS);

    const ctx = await session.openVisibleContext();
    browser = ctx.browser;
    page = await session.newBackgroundPage(ctx.context);
    // 내 글 목록(RSS)과 이웃들의 최신 글(RSS)은 로그인 화면을 여는 동안 미리 가져오기 시작한다
    const allPostsP = fetchRss(BLOG_ID);
    allPostsP.catch(() => {});
    const cachedIds = cache && Array.isArray(cache.neighbors) ? cache.neighbors.map((n) => n.blogId) : [];
    const prefetchP = fetchLatestPosts(cachedIds);
    prefetchP.catch(() => {});

    await page.goto(`https://m.blog.naver.com/${BLOG_ID}`, { waitUntil: "domcontentloaded" });
    const me = await pageFetchJson(page, "/api/current-user").catch(() => null);
    if (!me || !me.result || !me.result.loggedIn || me.result.userId !== BLOG_ID) {
      await page.close().catch(() => {});
      refreshState = { running: false, progress: "", error: "네이버에 로그인되어 있지 않아요. [네이버 로그인]을 눌러 크롬에서 로그인한 뒤 다시 불러와주세요.", needLogin: true };
      return;
    }

    // 이웃 목록 읽기(스크롤)는 별도 탭에서, 글별 공감·댓글 확인과 동시에 진행한다
    let buddyP = null;
    if (!listFresh) {
      buddyP = (async () => {
        buddyPage = await session.newBackgroundPage(ctx.context);
        const myAdded = await fetchBuddyList(buddyPage, "");
        const addedMe = await fetchBuddyList(buddyPage, "addedList");
        return { myAdded, addedMe };
      })().then((r) => ({ ok: true, ...r }), (e) => ({ ok: false, e }));
    }

    refreshState.progress = "내 글 목록 가져오는 중...";
    const since = Date.now() - days * 24 * 3600 * 1000;
    const inRange = (d) => !d || new Date(d).getTime() >= since;
    const postSince = Date.now() - Math.max(days, postDays) * 24 * 3600 * 1000;
    const allPosts = await allPostsP;
    const posts = allPosts.filter((p) => new Date(p.date).getTime() >= postSince).slice(0, maxPosts);
    if (!posts.length) throw new Error(`최근 ${postDays}일 동안 쓴 글이 없습니다.`);
    const blogNo = await fetchBlogNo(BLOG_ID, posts[0].logNo);

    // 글별 공감·댓글: 글 4개씩 동시에, 한 글 안에서도 공감과 댓글을 동시에 가져온다
    const fetched = new Array(posts.length);
    let nextPost = 0;
    let donePosts = 0;
    const postWorker = async () => {
      while (nextPost < posts.length) {
        const idx = nextPost++;
        const [likes, comments] = await Promise.all([withRetry(() => fetchSympathies(page, posts[idx].logNo)), withRetry(() => fetchComments(blogNo, posts[idx].logNo))]);
        fetched[idx] = { likes, comments };
        refreshState.progress = `공감·댓글 확인 중 (${++donePosts}/${posts.length})`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, posts.length) }, postWorker));

    // 결과는 예전과 똑같은 순서(글 → 공감 → 댓글)로 모은다
    const people = {}; // blogId -> person (최근 N일 안에 공감/댓글 준 사람)
    const person = (blogId, nickname) =>
      (people[blogId] ||= { blogId, nickname, profileImage: "", likes: [], comments: [] });
    const postStats = [];
    const myComments = []; // 추천 댓글 만들 때 참고할 내 말투 샘플
    const unanswered = [];
    for (const [i, post] of posts.entries()) {
      const postRef = { logNo: post.logNo, title: post.title };
      const { likes, comments } = fetched[i];
      for (const u of likes) {
        if (!inRange(u.date)) continue;
        const p = person(u.blogId, u.nickname);
        p.profileImage ||= u.profileImage;
        p.likes.push({ ...postRef, date: u.date });
      }
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
    }

    // 이웃 목록(내가 추가 ∪ 나를 추가 ∪ 최근 소통한 사람)으로 합친다
    const neighbors = {};
    const nb = (blogId) => (neighbors[blogId] ||= { blogId, iAdded: false, addedMe: false, mutual: false });
    let addedMeIds;
    let buddyUpdatedAt;
    if (listFresh) {
      // 최근에 읽어 둔 이웃 목록을 그대로 쓴다 (이웃 관계 표시만 가져오고, 글·공감 수는 아래에서 새로 계산)
      refreshState.progress = "이웃 목록은 방금 읽어 둔 걸 써요";
      for (const c of cache.neighbors.filter((x) => x.iAdded || x.addedMe || x.mutual)) {
        const n = nb(c.blogId);
        for (const k of ["nickname", "blogName", "profileImage", "iAdded", "addedMe", "mutual", "addedMeOrder"]) if (c[k] !== undefined) n[k] = c[k];
      }
      addedMeIds = Object.values(neighbors).filter((n) => n.addedMe).sort((x, y) => (x.addedMeOrder ?? 1e9) - (y.addedMeOrder ?? 1e9)).map((n) => n.blogId);
      buddyUpdatedAt = cache.buddyUpdatedAt;
    } else {
      refreshState.progress = "이웃 목록 가져오는 중...";
      const r = await buddyP;
      if (!r.ok) throw r.e;
      const { myAdded, addedMe } = r;
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
      addedMeIds = addedMe.map((b) => b.blogId);
      buddyUpdatedAt = new Date().toISOString();
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

    // 최신 글: 이웃 목록 전체 (내가 추가 + 나를 추가 + 최근 소통한 사람). 미리 가져온 것을 쓰고, 처음 보는 사람만 새로 가져온다
    refreshState.progress = "이웃 최신 글 확인 중...";
    const ids = Object.keys(neighbors);
    const latest = await prefetchP.catch(() => ({}));
    const missing = ids.filter((id) => !latest[id]);
    if (missing.length) Object.assign(latest, await fetchLatestPosts(missing));
    for (const id of ids) {
      const l = latest[id] || { latest: null, recent: [] };
      neighbors[id].latestPost = l.latest;
      neighbors[id].recentPosts = l.recent;
      if (people[id]) people[id].latestPost = l.latest;
    }

    updateSeen(Object.values(neighbors), addedMeIds);

    const cacheOut = {
      updatedAt: new Date().toISOString(),
      buddyUpdatedAt, // 이웃 목록(누가 이웃인지)을 마지막으로 읽은 시각
      refreshMs: Date.now() - t0,
      days,
      lastPostDate: allPosts[0] ? allPosts[0].date : null,
      posts: postStats,
      people: Object.values(people),
      neighbors: Object.values(neighbors),
      unanswered: unanswered.sort((a, b) => new Date(b.date) - new Date(a.date)),
      myComments: myComments.sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20).map((c) => c.text),
    };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheOut, null, 2));
    refreshState = { running: false, progress: "완료", error: null, needLogin: false, ms: Date.now() - t0 };
  } catch (e) {
    refreshState = { running: false, progress: "", error: e.message, needLogin: false };
  } finally {
    if (page) await page.close().catch(() => {}); // 사용자 크롬에 탭이 남지 않게
    if (buddyPage) await buddyPage.close().catch(() => {});
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
