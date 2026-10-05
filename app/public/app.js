// --- 자동화가 도는 동안 화면 전체를 막는 "로딩 중" 팝업 (다른 버튼을 눌러 꼬이는 것을 막는다) ---
let busyCount = 0;
function busyOn(msg, title) {
  busyCount++;
  const o = document.getElementById("busy-overlay");
  if (!o) return;
  document.getElementById("busy-title").textContent = title || "자동으로 진행 중이에요";
  document.getElementById("busy-msg").textContent = msg || "끝날 때까지 다른 곳을 누르지 말고 기다려주세요.";
  o.style.display = "flex";
}
function busyOff() {
  busyCount = Math.max(0, busyCount - 1);
  const o = document.getElementById("busy-overlay");
  if (o && !busyCount) o.style.display = "none";
}
const setAiButtons = (disabled) => document.querySelectorAll(".handoff-btn, .format-analyze-btn, #open-editor-btn").forEach((b) => (b.disabled = disabled));
let savedDraftOnce = false; // 이 글을 이미 임시저장했으면, 다시 저장할 땐 새 글 대신 그 글에 이어서 덮어쓴다

const $ = (sel) => document.querySelector(sel);

let selectedItems = [];
let selectedImagePaths = {}; // { query: path }
let currentPost = null; // 최근 /api/generate 결과 (introLines/sectionHeadings/sections 포함)

let loginPollTimer = null;

async function refreshLoginStatus() {
  const r = await fetch("/api/session-status").then((r) => r.json());
  const el = $("#login-status");
  const guide = $("#login-guide");
  if (guide) guide.style.display = r.loggedIn ? "none" : "block"; // 로그인이 안 돼 있을 때만 처음 쓰는 분을 위한 안내를 맨 앞에 보여준다

  if (r.loggedIn) {
    if (!window.__wasLoggedIn && window.__loginTried) {
      // 방금 로그인이 끝났을 때: 안내하고 바로 관심분야 입력으로
      const t = document.createElement("div");
      t.textContent = "✅ 네이버 로그인이 끝났어요! 관심분야를 입력해보세요";
      t.style.cssText = "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:99996;background:#03c75a;color:#fff;font-weight:700;padding:12px 20px;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.2);font-size:14px";
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 4000);
      $("#keyword") && $("#keyword").focus();
    }
    window.__wasLoggedIn = true;
    el.textContent = "로그인됨";
    el.className = "status-pill ok";
    stopLoginPolling();
    $("#login-btn").disabled = false;
  } else if (r.watching) {
    el.textContent = "크롬에서 로그인해주세요 (자동 감지 중...)";
    el.className = "status-pill no";
    $("#login-btn").disabled = true;
  } else {
    el.textContent = r.watchError ? "로그인 실패: " + r.watchError : "로그인 필요";
    el.className = "status-pill no";
    $("#login-btn").disabled = false;
    stopLoginPolling();
  }
  return r;
}

function startLoginPolling() {
  stopLoginPolling();
  loginPollTimer = setInterval(refreshLoginStatus, 2000);
}

function stopLoginPolling() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

$("#login-btn").addEventListener("click", async () => {
  window.__loginTried = true;
  $("#login-btn").disabled = true;
  $("#login-status").textContent = "크롬 창을 여는 중...";
  try {
    const r = await fetch("/api/login", { method: "POST" }).then((r) => {
      if (!r.ok) return r.json().then((e) => Promise.reject(e));
      return r.json();
    });
    if (r.alreadyLoggedIn) {
      refreshLoginStatus();
      return;
    }
    // 크롬 창이 열렸으니, 사용자가 로그인만 하면 자동으로 감지되도록 폴링 시작
    startLoginPolling();
  } catch (e) {
    alert("로그인 시작 실패: " + (e.error || e.message));
    $("#login-btn").disabled = false;
  }
});

// ---- 글감 찾기: 인기글 / 나무위키 / 후기·리뷰 / 뉴스로 나눠서 보여주고, 🔄로 새 글감을 다시 찾는다 ----
const GROUPS = [
  { key: "neighbor", icon: "👥", name: "이웃 블로거 글", type: "이웃 글", cls: "neighbor", hint: "이 주제로 이웃들이 최근 쓴 글 — 어떤 점이 인기인지 참고용" },
  { key: "popular", icon: "🔥", name: "인기글", type: "블로그", cls: "blog", hint: "지금 많이 읽히는 글 — 주제 잡기·제목 참고용" },
  { key: "namu", icon: "📚", name: "나무위키", type: "나무위키", cls: "wiki", hint: "정확한 개념·배경을 확인할 수 있는 근거 자료" },
  { key: "review", icon: "⭐", name: "후기·리뷰", type: "후기", cls: "review", hint: "직접 써보고 쓴 글 — 경험담·장단점 참고용" },
  { key: "news", icon: "📰", name: "최신 뉴스", type: "뉴스", cls: "news", hint: "요즘 이슈·수치 확인용" },
];
let searchState = { keyword: "", round: 0, shown: new Set(), all: [] };
let searchCtx = null; // 이웃 소통·성과 통계에서 넘어온 주제 정보 {keyword,title,questions,refs}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function itemHtml(item, i, checked) {
  return `
    <label class="item">
      <input type="checkbox" data-idx="${i}" class="pick"${checked ? " checked" : ""} />
      <div>
        <span class="tag ${item.cls}">${esc(item.type)}</span>
        <a href="${esc(item.link)}" target="_blank">${esc(item.title)}</a>
        <small>${esc(item.snippet || "")}</small>
      </div>
    </label>`;
}

function renderSearch(r, pinned) {
  // 이번에 새로 찾은 글 + 지난번에 체크해둔 글(맨 위에 고정)
  const all = [];
  const sections = [];
  if (pinned.length) {
    sections.push(`<h3 class="grp-title">✅ 선택해둔 글감 <small>(다시 찾아도 유지돼요)</small></h3>` + pinned.map((it) => (all.push(it), itemHtml(it, all.length - 1, true))).join(""));
  }
  for (const g of GROUPS) {
    const src = g.key === "neighbor" ? (searchCtx ? searchCtx.refs || [] : []).map((x) => ({ title: x.title, link: x.link, snippet: (x.nick ? x.nick + " 님의 글" : "") })) : r[g.key] || [];
    if (g.key === "neighbor" && !src.length) continue; // 이웃 글 정보가 없으면 이 묶음은 숨김
    const list = src.filter((x) => !pinned.some((p) => p.link === x.link)).map((x) => ({ ...x, type: g.type, cls: g.cls }));
    let body = list.map((it) => (all.push(it), itemHtml(it, all.length - 1, false))).join("");
    if (g.key === "namu" && !list.length) {
      body = `<div class="empty-state">이 키워드의 새 나무위키 문서가 없어요. <a href="${esc(r.namuSearchUrl)}" target="_blank">나무위키에서 직접 검색 ↗</a></div>`;
    } else if (!list.length) {
      body = `<div class="empty-state">새로 찾은 글이 없어요.</div>`;
    }
    const reloadBtn = g.key === "neighbor" ? "" : `<button type="button" class="grp-reload" data-grp="${g.key}" title="이 묶음만 새로운 글로 다시 찾기" aria-label="${esc(g.name)} 새로 찾기">🔄</button>`;
    sections.push(`<h3 class="grp-title"><span>${g.icon} ${g.name} <small>${esc(g.hint)}</small></span>${reloadBtn}</h3>` + body);
  }
  searchState.all = all;

  const box = $("#search-results");
  box.classList.remove("empty-state");
  box.innerHTML =
    sections.join("") +
    `<div class="reload-row"><button id="reload-btn" class="btn btn-outline">🔄 다른 글감 새로 찾기</button>
       <small>${searchState.round + 1}번째 결과 · 누를 때마다 새로운 글·다른 검색어로 다시 찾아요 (체크한 글감은 그대로 남아요)</small></div>`;

  box.querySelectorAll(".pick").forEach((cb) => {
    cb.addEventListener("change", () => {
      const item = all[Number(cb.dataset.idx)];
      if (cb.checked) selectedItems.push(item);
      else selectedItems = selectedItems.filter((x) => x.link !== item.link);
    });
  });
  // 제목 링크는 체크박스(label) 안에 있어서 target="_blank"가 브라우저에 따라 새 탭 대신
  // 현재 화면을 바꿔버리는 경우가 있다. 확실하게 새 창으로 열리도록 직접 처리한다.
  box.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(a.href, "_blank", "noopener,noreferrer");
    });
  });
  $("#reload-btn").addEventListener("click", () => runSearch(searchState.keyword, searchState.round + 1));
  box.querySelectorAll(".grp-reload").forEach((b) => b.addEventListener("click", () => reloadGroup(b.dataset.grp, b)));
}

/** 한 묶음(후기·나무위키·인기글·뉴스)만 새로운 글로 다시 찾는다. 다른 묶음과 체크해둔 글감은 그대로 둔다 */
async function reloadGroup(key, btn) {
  if (!searchState.last || btn.disabled) return;
  searchState.groupRound = searchState.groupRound || {};
  const round = (searchState.groupRound[key] || searchState.round || 0) + 1;
  btn.disabled = true;
  btn.classList.add("spin");
  const r = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: searchState.keyword, round, exclude: [...searchState.shown], only: key }),
  })
    .then((x) => x.json())
    .catch((e) => ({ error: e.message }));
  btn.classList.remove("spin");
  btn.disabled = false;
  if (r.error) return alert("새로 찾지 못했어요: " + r.error);
  searchState.groupRound[key] = round;
  for (const x of r[key] || []) searchState.shown.add(x.link);
  if (!(r[key] || []).length) {
    btn.title = "더 이상 새로 보여줄 글이 없어요";
    btn.textContent = "✔";
    return;
  }
  searchState.last = { ...searchState.last, [key]: r[key] };
  renderSearch(searchState.last, selectedItems.slice());
}

async function runSearch(keyword, round) {
  const pinned = selectedItems.slice(); // 체크해둔 글감은 다시 찾아도 유지
  $("#search-btn").disabled = true;
  if ($("#reload-btn")) $("#reload-btn").disabled = true;
  $("#search-results").classList.add("empty-state");
  if (!round) $("#search-results").textContent = "검색 중... (인기글·나무위키·후기를 찾는 중이라 10~20초 걸려요)";
  else $("#reload-btn").textContent = "찾는 중...";

  const exclude = round ? [...searchState.shown] : [];
  const r = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword, round, exclude, ctx: searchCtx && !searchCtx.resolved ? { titles: [searchCtx.title, ...(searchCtx.refs || []).map((x) => x.title)] } : undefined }),
  })
    .then((r) => r.json())
    .catch((e) => ({ error: e.message }));
  $("#search-btn").disabled = false;

  if (r.error) {
    $("#search-results").textContent = "오류: " + r.error;
    return;
  }
  if (!round) searchState = { keyword, round: 0, shown: new Set(), all: [] };
  searchState.round = round;
  for (const g of GROUPS) for (const x of r[g.key] || []) searchState.shown.add(x.link);
  if (r.richKeyword && r.richKeyword !== keyword) $("#ctx-rich") && ($("#ctx-rich").textContent = r.richKeyword);
  if (!round) selectedItems = [];
  searchState.last = r;
  searchState.groupRound = {};
  renderSearch(r, round ? pinned : []);
  if (r.exhausted) $("#reload-btn").insertAdjacentHTML("afterend", `<p class="hint">더 이상 새로 보여줄 글이 없어요. 다른 키워드를 넣어보세요.</p>`);

  $("#step-generate").hidden = false;
  setActiveStep(2);
}

// 관심분야 입력칸에서 Enter: 처음엔 [뉴스·블로그 찾기], 같은 검색어로 또 누르면 [🔄 다른 글감 새로 찾기]
$("#keyword").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return; // 한글을 치는 중(글자 확정 Enter)에는 무시
  e.preventDefault();
  if ($("#search-btn").disabled) return; // 찾는 중이면 기다린다
  const kw = $("#keyword").value.trim();
  if (!kw) return;
  if (searchState.keyword && kw === searchState.keyword && searchState.all.length) runSearch(kw, searchState.round + 1);
  else $("#search-btn").click();
});

$("#search-btn").addEventListener("click", () => {
  const keyword = $("#keyword").value.trim();
  if (!keyword) return alert("키워드를 입력해주세요.");
  if (searchCtx && keyword !== searchCtx.keyword) { searchCtx = null; renderCtxBox(); } // 직접 다른 키워드를 검색하면 이어받은 주제 정보는 쓰지 않는다
  runSearch(keyword, 0);
});

$("#open-editor-btn").addEventListener("click", async () => {
  setAiButtons(true);
  busyOn("블로그 글쓰기 창을 여는 중이에요. 잠시만 기다려주세요.", "블로그 에디터를 여는 중이에요");
  $("#open-editor-status").textContent = "블로그 → 글쓰기 → 템플릿 적용 중입니다... (크롬 창을 확인하세요)";
  const r = await fetch("/api/open-editor", { method: "POST" }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  busyOff();
  setAiButtons(false);
  $("#open-editor-status").textContent = r.error
    ? "오류: " + r.error
    : "완료! 크롬 창에서 템플릿이 적용된 에디터를 확인하고 직접 타이핑해주세요.";
});

function renderPostPreview(r) {
  const el = $("#post-preview");
  const intro = (r.introLines || []).join(" / ");
  const parts = [`<h4>INTRO</h4><p>${escapeHtml(intro)}</p>`];
  (r.sections || []).forEach((body, i) => {
    const headingLines = (r.sectionHeadingLines && r.sectionHeadingLines[i]) || [];
    const heading = headingLines.length ? headingLines.join(" / ") : `${i + 1}번`;
    parts.push(`<h4>${i + 1}. ${escapeHtml(heading)}</h4><p>${previewText(body)}</p>`);
  });
  el.innerHTML = parts.join("");
}

// 미리보기에서도 에디터에 들어갈 모양대로: **굵게** → 굵게, 줄바꿈 유지, "- " 줄 → • 목록
function previewText(s) {
  return escapeHtml(s || "")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\n/g, "<br>");
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderImageCandidates(imgRes) {
  const container = $("#image-candidates");
  container.innerHTML = "";
  for (const [query, candidates] of Object.entries(imgRes)) {
    const group = document.createElement("div");
    group.className = "image-group";
    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    group.innerHTML = `<strong>${query}</strong>`;
    candidates.forEach((c, idx) => {
      const img = document.createElement("img");
      img.src = c.webPath;
      img.title = `점수 ${c.score} - ${c.reason}`;
      if (idx === 0) {
        img.classList.add("selected");
        selectedImagePaths[query] = c.path;
      }
      img.addEventListener("click", () => {
        thumbs.querySelectorAll("img").forEach((i) => i.classList.remove("selected"));
        img.classList.add("selected");
        selectedImagePaths[query] = c.path;
      });
      thumbs.appendChild(img);
    });
    group.appendChild(thumbs);
    container.appendChild(group);
  }
}

function setActiveStep(n) {
  document.querySelectorAll(".step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) === n);
  });
}

$("#save-draft-btn").addEventListener("click", async () => {
  if (!currentPost) return alert("먼저 글을 생성해주세요.");
  $("#save-draft-btn").disabled = true;
  setAiButtons(true);
  busyOn("네이버 블로그 글쓰기 창에 본문을 입력하는 중이에요 (1~2분). 크롬 창이 열려 있어도 건드리지 말고 기다려주세요.", "블로그에 글을 쓰는 중이에요");
  $("#save-status").textContent = "네이버 블로그에 본문 임시저장 중입니다... (1~2분 소요)";
  const r = await fetch("/api/save-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: $("#post-title").value,
      introLines: currentPost.introLines,
      sectionHeadingLines: currentPost.sectionHeadingLines,
      sections: currentPost.sections,
      imagePaths: Object.values(selectedImagePaths),
      useTemplate: $("#use-template-checkbox").checked,
      continueDraft: savedDraftOnce,
      tpl: currentPost.tpl,
    }),
  }).then((r) => r.json()).catch((e) => ({ error: e.message }));

  busyOff();
  setAiButtons(false);
  if (!r.error) { savedDraftOnce = true; maybeCloseImageTabs(); }
  $("#save-draft-btn").disabled = false;
  $("#save-status").textContent = r.error
    ? "오류: " + r.error
    : "본문 임시저장 완료! 네이버 에디터에서 검토/수정 후, 아래 4단계에서 목차·요약을 채워주세요.";
  if (!r.error) {
    $("#step-finalize").hidden = false;
    setActiveStep(4);
  }
});

$("#finalize-btn").addEventListener("click", async () => {
  $("#finalize-btn").disabled = true;
  setAiButtons(true);
  busyOn("임시글을 열어 목차·요약을 채우는 중이에요 (1~2분). 끝날 때까지 기다려주세요.", "목차와 요약을 채우는 중이에요");
  $("#finalize-status").textContent = "지금 임시글을 열어서 목차·요약을 채우는 중입니다... (1~2분 소요)";
  const r = await fetch("/api/finalize-toc", { method: "POST" }).then((r) => r.json()).catch((e) => ({ error: e.message }));
  busyOff();
  setAiButtons(false);
  $("#finalize-btn").disabled = false;
  $("#finalize-status").textContent = r.error ? "오류: " + r.error : "목차·요약까지 완료! 네이버 블로그에서 최종 확인 후 발행해주세요.";
});

// 저장된 세션이 있어도 처음에는 "로그인 필요"로 시작하고, 실제 로그인 상태는 브라우저에서 눈으로 확인해 갱신한다.
// 이 브라우저 창에서 처음 열 때는 버튼을 누르지 않아도 로그인 확인·로그인 화면을 자동으로 연다
// (이미 로그인돼 있으면 로그인 화면 없이 바로 "로그인됨"). 새로고침할 때마다 다시 열지는 않는다.
$("#login-status").textContent = "로그인 필요";
$("#login-status").className = "status-pill no";
(() => {
  let first = true;
  try { first = !sessionStorage.getItem("nbh-autologin"); sessionStorage.setItem("nbh-autologin", "1"); } catch {}
  if (!first) return;
  $("#login-status").textContent = "로그인 확인 중...";
  setTimeout(() => $("#login-btn").click(), 700);
})();

// --- 체크한 글감을 AI(Claude / ChatGPT / Gemini)에게 넘겨서 대화하며 쓰기 ---
const AI_SITES = {
  claude: { name: "Claude", url: "https://claude.ai/new" },
  chatgpt: { name: "ChatGPT", url: "https://chatgpt.com/" },
  gemini: { name: "Gemini", url: "https://gemini.google.com/app" },
};

// 버튼을 누르면: 로그인용 크롬에 그 AI 채팅 탭을 열고 요청문을 자동으로 보냄 → 사용자가 탭에서 대화 →
// "완성"이라고 해서 AI가 결과 JSON을 내놓으면 앱이 알아채서 네이버 글쓰기 창을 열어 채운다.
const AI_STATUS_TEXT = {
  opening: (n) => `${n} 탭을 여는 중이에요...`,
  needLogin: (n) => `열린 크롬 탭에서 ${n}에 로그인해주세요 (처음 한 번만). 로그인하면 요청문이 자동으로 들어가요.`,
  sending: (n) => `${n}에 요청문을 보내는 중이에요...`,
  chatting: (n) =>
    `✅ ${n}에 요청문을 보냈어요. 크롬 탭에서 ${n}이 제안하는 방향을 고르고 초안을 다듬은 뒤, "완성"이라고 보내세요. 결과가 나오면 자동으로 블로그 글쓰기 창이 열려요.`,
  closed: (n) => `${n} 탭이 닫혀서 연결을 끝냈어요. 다시 하려면 버튼을 눌러주세요.`,
  timeout: (n) => `${n} 대화를 기다리다 시간이 지났어요. 결과 JSON을 아래에 직접 붙여넣어도 돼요.`,
};
const FORMAT_CHATTING = (n) =>
  `✅ ${n}에 내 최근 글을 보내 분석을 맡겼어요. 크롬 탭에서 분석이 끝나고 JSON이 나오면 자동으로 저장돼요. (결과가 마음에 안 들면 탭에서 고쳐달라고 하세요)`;
let aiPollTimer = null;
let aiBusy = false;

// --- 내 블로그 글 형식 ---
let formatInfo = null;
async function loadFormat() {
  formatInfo = await fetch("/api/format").then((r) => r.json()).catch(() => null);
  if (!formatInfo) return;
  $("#format-name").textContent = formatInfo.name;
  $("#format-json").value = formatInfo.format ? JSON.stringify(formatInfo.format, null, 2) : "";
  // 내 템플릿 모드: 이 칸의 AI 버튼은 "분석"이 아니라 "내 템플릿에 바로 글쓰기"로 바뀐다
  const my = formatInfo.kind === "mytpl";
  document.querySelectorAll(".format-analyze-btn").forEach((b) => {
    b.textContent = my ? b.textContent.replace("로 분석", "로 내 템플릿에 쓰기") : b.textContent.replace("로 내 템플릿에 쓰기", "로 분석");
  });
  const desc = $("#format-desc");
  if (desc) desc.textContent = my ? "내 네이버 템플릿(앞으로 쓸 템플릿)에 맞춰 바로 써요. 위에서 글감을 체크하거나 주제를 적은 뒤 AI 버튼을 누르면, 대화를 마치고 \"완성\"이라고 보낼 때 템플릿 자리에 글이 채워져요." : "내 최근 글 3개를 AI가 분석해서 제목·말투·구성·마무리 방식을 저장해두면, 초안을 쓸 때 그 형식을 따라요. (내 컴퓨터에만 저장)";
  const det = $("#format-details");
  if (det) det.style.display = my ? "none" : "";
}
loadFormat();

document.querySelectorAll(".format-analyze-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    // 내 템플릿 모드에서는 위 "AI와 대화하면서 글쓰기"의 같은 AI 버튼을 누른 것과 똑같이 글쓰기를 시작한다
    if (formatInfo && formatInfo.kind === "mytpl") {
      const target = document.querySelector(`.handoff-btn[data-ai="${btn.dataset.ai}"]`);
      if (target) target.click();
      return;
    }
    document.querySelectorAll(".format-analyze-btn").forEach((b) => (b.disabled = true));
    $("#format-status").textContent = "내 블로그 최근 글을 읽는 중이에요...";
    const r = await fetch("/api/format/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai: btn.dataset.ai }),
    })
      .then((r) => r.json())
      .catch((e) => ({ error: e.message }));
    document.querySelectorAll(".format-analyze-btn").forEach((b) => (b.disabled = false));
    if (r.error) {
      $("#format-status").textContent = "오류: " + r.error;
      return;
    }
    $("#format-status").textContent = `최근 글 ${r.sampleTitles.length}개를 읽었어요 (${r.sampleTitles.join(", ")}). AI 탭을 여는 중...`;
    clearInterval(aiPollTimer);
    aiPollTimer = setInterval(pollAiChat, 2000);
  });
});

$("#format-save-btn").addEventListener("click", async () => {
  let f;
  try {
    const m = $("#format-json").value.match(/\{[\s\S]*\}/);
    f = JSON.parse(m ? m[0] : "");
  } catch {
    $("#format-status").textContent = "저장 실패: JSON 형식이 올바르지 않아요.";
    return;
  }
  const r = await fetch("/api/format", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }).then((r) => r.json());
  $("#format-status").textContent = r.error ? "저장 실패: " + r.error : `✅ 저장했어요: "${r.name}"`;
  loadFormat();
});

$("#format-reset-btn").addEventListener("click", async () => {
  if (!confirm("저장된 내 블로그 형식을 지우고 기본 형식으로 돌아갈까요?")) return;
  await fetch("/api/format", { method: "DELETE" });
  $("#format-status").textContent = "기본 형식으로 돌아갔어요.";
  loadFormat();
});

document.addEventListener("click", async (e) => {
  if (e.target.id === "ai-popup-go") {
    const r = await fetch("/api/ai-chat/focus", { method: "POST" }).then((x) => x.json()).catch(() => ({}));
    if (r.error) $("#handoff-status").textContent = "오류: " + r.error;
  } else if (e.target.id === "ai-popup-stop") {
    await fetch("/api/ai-chat/stop", { method: "POST" }).catch(() => {});
    clearInterval(aiPollTimer);
    $("#ai-popup").style.display = "none";
    if (aiBusy) { aiBusy = false; busyOff(); }
    setAiButtons(false);
    $("#handoff-status").textContent = "대화 지켜보기를 멈췄어요. 다시 하려면 AI 버튼을 눌러주세요.";
  }
});

async function pollAiChat() {
  const st = await fetch("/api/ai-chat/status").then((r) => r.json()).catch(() => null);
  if (!st || st.status === "idle" || st.status === "taken") return;
  const isFormat = st.kind === "format";
  const running = ["opening", "needLogin", "sending", "chatting"].includes(st.status);
  setAiButtons(running); // 진행 중에는 다른 AI 버튼을 눌러 꼬이지 않게 잠근다
  const quick = ["opening", "sending"].includes(st.status); // 크롬이 열리고 요청문이 들어가는 짧은 동안만 화면을 막는다
  if (quick && !aiBusy) { aiBusy = true; busyOn(st.name + " 창을 열고 요청문을 넣는 중이에요. 잠시만 기다려주세요.", "AI 창을 여는 중이에요"); }
  if (!quick && aiBusy) { aiBusy = false; busyOff(); }
  // 대화 중에는 "AI에서 대화 나눠보세요" 안내 창을 띄우고, 완성(결과 도착)·오류·종료 때 자동으로 닫는다
  // 처음 쓰는 AI(또는 로그인이 필요한 상태)면 로그인 안내를 띄운다. 대화가 시작되면(요청문이 들어가면) 자동으로 닫는다
  const seenKey = "nbh-ai-seen-" + (st.ai || "");
  let seen = false;
  try { seen = !!localStorage.getItem(seenKey); if (st.status === "chatting") localStorage.setItem(seenKey, "1"); } catch {}
  const lg = $("#ai-login-guide");
  if (lg) {
    const show = !isFormat && (st.status === "needLogin" || (!seen && ["opening", "sending"].includes(st.status)));
    if (show) $("#ai-login-name").textContent = st.name;
    lg.style.display = show ? "block" : "none";
  }
  const pop = $("#ai-popup");
  if (pop) {
    if (st.status === "chatting") { $("#ai-popup-title").textContent = isFormat ? `${st.name}에서 분석 결과를 기다리는 중이에요` : `${st.name}에서 대화 나눠보세요`; pop.style.display = "block"; }
    else pop.style.display = "none";
  }
  if (!running && ["error", "timeout", "closed"].includes(st.status)) $("#handoff-prompt-box").hidden = false; // 자동이 안 됐을 때만 수동 방법을 보여준다
  const line = isFormat ? $("#format-status") : $("#handoff-status");
  if (st.status === "done") {
    clearInterval(aiPollTimer);
    if (aiBusy) { aiBusy = false; busyOff(); }
    setAiButtons(false);
    await fetch("/api/ai-chat/taken", { method: "POST" }).catch(() => {});
    if (isFormat) {
      const r = await fetch("/api/format", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(st.result) })
        .then((r) => r.json())
        .catch((e) => ({ error: e.message }));
      line.textContent = r.error ? "저장 실패: " + r.error : `✅ ${st.name}가 분석한 형식을 저장했어요: "${r.name}". 이제 초안을 쓸 때 이 형식을 따라요.`;
      loadFormat();
    } else {
      line.textContent = `✅ ${st.name}의 완성본을 받아왔어요.`;
      loadPost(st.result);
    }
    return;
  }
  if (st.status === "error") {
    clearInterval(aiPollTimer);
    if (aiBusy) { aiBusy = false; busyOff(); }
    setAiButtons(false);
    line.textContent = "오류: " + st.error + (isFormat ? "" : " — 아래 요청문을 복사해서 직접 붙여넣어도 돼요.");
    return;
  }
  const f = isFormat && st.status === "chatting" ? FORMAT_CHATTING : AI_STATUS_TEXT[st.status];
  if (f) line.textContent = f(st.name) + (st.note ? " " + st.note : "");
  if (["closed", "timeout"].includes(st.status)) { clearInterval(aiPollTimer); if (aiBusy) { aiBusy = false; busyOff(); } setAiButtons(false); }
}

document.querySelectorAll(".handoff-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!selectedItems.length && !$("#keyword").value.trim()) return alert("글감을 하나 이상 선택하거나, 위 입력칸에 주제를 적어주세요.");
    if (!selectedItems.length && !confirm("선택한 글감 없이 시작할까요?\n\nAI가 먼저 질문을 하고, 내가 답한 사실로만 글을 써요. (검색 결과가 없는 주제에 알맞아요)")) return;
    const ai = btn.dataset.ai;
    setAiButtons(true);
    $("#handoff-status").textContent = "글감 본문을 모으는 중이에요...";
    const r = await fetch("/api/ai-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai, keyword: $("#keyword").value.trim(), selected: selectedItems, context: searchCtx ? { title: searchCtx.title, questions: searchCtx.questions, refs: searchCtx.refs } : undefined }),
    })
      .then((r) => r.json())
      .catch((e) => ({ error: e.message }));
    if (r.error) {
      setAiButtons(false);
      $("#handoff-status").textContent = "오류: " + r.error;
      return;
    }
    // 요청문은 미리 넣어 두고, 자동이 안 됐을 때만 수동 입력칸을 보여준다 (평소에는 헷갈리지 않게 숨김)
    $("#handoff-prompt").value = r.prompt;
    $("#handoff-prompt-box").hidden = true;
    clearInterval(aiPollTimer);
    aiPollTimer = setInterval(pollAiChat, 2000);
    pollAiChat();
  });
});

$("#handoff-copy-btn").addEventListener("click", async () => {
  const ta = $("#handoff-prompt");
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch {
    ta.select();
    document.execCommand("copy");
  }
  $("#handoff-copy-btn").textContent = "복사됨 ✓";
  setTimeout(() => ($("#handoff-copy-btn").textContent = "복사"), 1500);
});

// AI가 준 최종 JSON을 붙여넣으면 3단계 미리보기로 넘어간다 (이후 임시저장은 기존 버튼 그대로)
$("#paste-result-btn").addEventListener("click", () => {
  const raw = $("#paste-result").value;
  let post;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("JSON을 찾지 못했어요");
    post = JSON.parse(m[0]);
  } catch (e) {
    $("#paste-status").textContent = "불러오기 실패: AI가 준 JSON 코드블록을 통째로 붙여넣어 주세요. (" + e.message + ")";
    return;
  }
  if (!post.title || !Array.isArray(post.sections) || !post.sections.length) {
    $("#paste-status").textContent = "불러오기 실패: title과 sections가 있어야 해요. AI에게 \"정해진 JSON 형식으로 다시 줘\"라고 해보세요.";
    return;
  }
  loadPost(post);
});

// 완성된 글(JSON)을 3단계 미리보기에 넣고, 바로 네이버 글쓰기 창을 열어 채운다 (기존 임시저장 흐름 재사용)
// ---- 소제목(챕터)별 이미지 ----
// 흐름: [검색 버튼] → 크롬에 이미지 검색이 열림 → 마음에 드는 이미지를 클릭하면 자동으로 복사됨
//       → 네이버 글쓰기 창에서 넣을 자리를 누르고 Ctrl+V.  (앱에 보이는 이미지를 누르면 다시 복사돼요)
const ENGINE_BTNS = [
  { id: "naver", label: "🔍 네이버 이미지", free: false },
  { id: "google", label: "🔍 구글 이미지", free: false },
  { id: "unsplash", label: "🆓 Unsplash", free: true },
  { id: "pexels", label: "🆓 Pexels", free: true },
  { id: "pixabay", label: "🆓 Pixabay", free: true },
  { id: "aigen", label: "🎨 AI로 이미지 만들기", free: false, ai: true },
];
let pickItems = [];
let pickPoll = null;
let pickSeen = {}; // 챕터별로 마지막에 화면에 반영한 복사 순번
let pickWait = {}; // 챕터별로 "준비 중" 상태가 시작된 시각 (오래 걸리면 안내)

function renderSectionImages(post) {
  const box = $("#image-candidates");
  box.classList.remove("empty-state");
  clearInterval(pickPoll);
  pickSeen = {};
  const n = (post.sections || []).length;
  if (!n) {
    box.classList.add("empty-state");
    box.textContent = "이 글에는 챕터가 없어요.";
    return;
  }
  const kws = Array.isArray(post.sectionImageKeywords) ? post.sectionImageKeywords : [];
  const tags = Array.isArray(post.sectionImageTags) ? post.sectionImageTags : [];
  const notes = Array.isArray(post.sectionImageNotes) ? post.sectionImageNotes : [];
  const oldImgs = Array.isArray(post.sectionImages) ? post.sectionImages : []; // 예전 형식(img 태그)이 오면 alt를 설명으로 쓴다
  const topic = (post.tags && post.tags[0]) || $("#keyword").value.trim() || "";
  const place = String(post.placeName || "").trim().slice(0, 30);
  // 장소(카페 등) 글이면 이미지 검색어를 "장소 이름 + 소제목 내용"으로 맞춘다 (이미 이름이 들어 있으면 그대로)
  const withPlace = (q, p) => (p && !q.replace(/\s/g, "").includes(p.replace(/\s/g, "")) ? `${p} ${q}`.slice(0, 50) : q);
  pickItems = Array.from({ length: n }, (_, i) => {
    const heading = ((post.sectionHeadingLines || [])[i] || []).join(" ").trim() || `${i + 1}번 챕터`;
    const oldAlt = (String(oldImgs[i] || "").match(/alt\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
    return {
      heading,
      note: String(notes[i] || oldAlt || "").trim(),
      tag: String(tags[i] || "").trim(),
      ko: withPlace(String(kws[i] || "").trim() || [topic, heading].filter(Boolean).join(" ").slice(0, 40), place), // AI가 안 줬으면 주제 키워드 + 챕터 제목. 장소 글이면 맨 앞에 장소 이름
      file: "",
      previewUrl: "",
      quality: "",
    };
  });

  box.innerHTML = `<p class="hint" id="si-summary" style="margin:0 0 6px"></p>
    <div class="si-guide">
      <b>이렇게 하세요</b>
      <ol>
        <li>챕터의 <b>🔍 검색 버튼</b>을 누르면 크롬에 이미지 검색이 열려요 (검색어는 자동으로 들어가 있어요)</li>
        <li>마음에 드는 이미지를 <b>클릭</b>하면 <b>자동으로 복사</b>돼요</li>
        <li><b>네이버 글쓰기 창</b>에서 이미지를 넣을 자리를 누르고 <b>Ctrl+V</b></li>
      </ol>
      <small>🆓는 무료로 써도 되는 사진 사이트예요. 네이버·구글 이미지는 저작권을 꼭 확인하세요. 아래에 보이는 이미지를 누르면 다시 복사돼요.</small>
    </div>
    ${pickItems
      .map(
        (it, i) => `<div class="si-row" data-i="${i}">
      <div class="si-head">${i + 1}. ${esc(it.heading)}</div>
      <div class="si-body">
        <div class="si-thumb"><div class="si-empty">아직 없음</div></div>
        <div class="si-info">
          ${it.note ? `<div class="si-alt">${esc(it.note)}</div>` : ""}
          <div class="si-tag">검색어: <b>${esc(it.ko)}</b>${it.tag ? ` · 영어 태그: <b>${esc(it.tag)}</b>` : ""}</div>
          <div class="si-links">${ENGINE_BTNS.map((e) => `<button type="button" class="si-link${e.free ? " free" : ""}${e.ai ? " ai" : ""}" data-engine="${e.id}" title="${e.ai ? "이 챕터 본문 내용으로 ChatGPT가 이미지를 만들어요 (1201×673)" : e.free ? "무료로 쓸 수 있는 사진 사이트" : "저작권을 꼭 확인하세요"}">${e.label}</button>`).join("")}</div>
          <div class="si-state"></div>
        </div>
      </div>
    </div>`
      )
      .join("")}`;
  updatePickSummary();

  box.querySelectorAll(".si-link").forEach((btn) => btn.addEventListener("click", () => startPickFor(Number(btn.closest(".si-row").dataset.i), btn.dataset.engine)));
  box.querySelectorAll(".si-thumb").forEach((th) => th.addEventListener("click", () => copyPicked(Number(th.closest(".si-row").dataset.i))));
}

const pickRow = (i) => document.querySelector(`.si-row[data-i="${i}"]`);
const pickState = (i, html) => { const r = pickRow(i); if (r) r.querySelector(".si-state").innerHTML = html; };
let pickTabsClosed = false;
/** 모든 챕터의 이미지를 골랐고 임시저장도 끝났으면, 이미지 검색으로 열어 둔 크롬 탭을 닫는다 (한 번만) */
function maybeCloseImageTabs() {
  if (pickTabsClosed || !savedDraftOnce || !pickItems.length || !pickItems.every((x) => x.file)) return;
  pickTabsClosed = true;
  fetch("/api/images/pick/close-tabs", { method: "POST" }).catch(() => {});
}

function updatePickSummary() {
  const el = $("#si-summary");
  if (!el) return;
  const got = pickItems.filter((x) => x.file).length;
  el.innerHTML = `소제목 아래에 넣을 이미지 — 고른 챕터 <b>${got}</b> / ${pickItems.length}`;
  maybeCloseImageTabs();
}
function paintThumb(i) {
  const it = pickItems[i];
  const th = pickRow(i).querySelector(".si-thumb");
  th.innerHTML = it.file ? `<img class="si-img" src="${esc(it.previewUrl)}" alt="${esc(it.note || it.heading)}" title="누르면 이 이미지가 복사돼요" style="cursor:pointer">` : `<div class="si-empty">아직 없음</div>`;
  th.style.cursor = it.file ? "pointer" : "default";
}

async function startGenFor(i) {
  const body = (currentPost && currentPost.sections && currentPost.sections[i]) || "";
  pickState(i, "🎨 ChatGPT에 이미지를 요청하는 중이에요...");
  const r = await fetch("/api/images/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapter: i, heading: pickItems[i].heading, body }) })
    .then((x) => x.json())
    .catch((e) => ({ error: e.message }));
  if (r.error) return pickState(i, `<span class="error">⚠ ${esc(netMsg(r.error))}</span>`);
  clearInterval(pickPoll);
  pickPoll = setInterval(pollPick, 1500);
  pollPick();
}

async function startPickFor(i, engine) {
  if (engine === "aigen") return startGenFor(i);
  pickWait[i] = 0;
  pickState(i, "⏳ 크롬에 이미지 검색을 여는 중이에요...");
  const r = await fetch("/api/images/pick", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapter: i, query: pickItems[i].ko, engine }) })
    .then((x) => x.json())
    .catch((e) => ({ error: e.message }));
  if (r.error) return pickState(i, `<span class="error">⚠ ${esc(netMsg(r.error))}</span>`);
  clearInterval(pickPoll);
  pickPoll = setInterval(pollPick, 1000);
  pollPick();
}

async function pollPick() {
  const st = await fetch("/api/images/pick/status").then((r) => r.json()).catch(() => null);
  if (!st || st.status === "idle" || st.chapter === undefined) return;
  const i = st.chapter;
  const it = pickItems[i];
  if (!it || !pickRow(i)) return clearInterval(pickPoll);
  // 지금 고르는 챕터가 아닌 칸은 "고른 이미지가 있으면 안내", 없으면 비움
  pickItems.forEach((x, k) => { if (k !== i && !x.file) pickState(k, ""); else if (k !== i) pickState(k, "✅ 복사했던 이미지예요 · 누르면 다시 복사돼요"); });
  if (st.file && pickSeen[i] !== st.seq) { // 새로 복사된 이미지
    pickSeen[i] = st.seq;
    Object.assign(it, { file: st.file, previewUrl: st.previewUrl, quality: st.quality });
    paintThumb(i);
    updatePickSummary();
  }
  const how = "네이버 글쓰기 창에서 넣을 자리를 누르고 <b>Ctrl+V</b>";
  if (it.copiedAt && Date.now() - it.copiedAt < 5000) return; // 방금 앱에서 이미지를 눌러 다시 복사했으면 그 안내를 잠깐 유지
  if (st.status === "generating") { pickState(i, `🎨 ${esc(st.note || "ChatGPT가 이미지를 만드는 중이에요 (1~2분)...")}`); return; }
  if (st.status === "opening") pickState(i, "⏳ 크롬에 이미지 검색을 여는 중이에요...");
  else if (st.status === "waiting") {
    const err = st.error ? `<br><span class="error">⚠ ${esc(st.error)}</span>` : "";
    if (st.file) pickState(i, `✅ 복사됐어요 (${esc(st.quality)}) · ${how} · 다른 이미지로 바꾸려면 크롬의 초록 줄을 누른 뒤 클릭하세요${err}`);
    else if (st.armed && st.autoAt && !st.autoTried) pickState(i, `🟢 준비됐어요! 크롬의 이미지 검색에서 마음에 드는 이미지를 <b>클릭</b>하세요. <b>${Math.max(0, Math.ceil((st.autoAt - Date.now()) / 1000))}초</b> 안에 안 고르면 맨 앞 이미지를 자동으로 골라 복사해요.`);
    else if (st.armed) pickState(i, `🟢 준비됐어요! 크롬의 이미지 검색에서 마음에 드는 이미지를 <b>클릭</b>하면 자동으로 복사돼요 (크롬 위쪽에 초록 안내줄이 보여요)${err}`);
    else {
      pickWait[i] = pickWait[i] || Date.now();
      const slow = Date.now() - pickWait[i] > 8000;
      pickState(i, slow ? `⚠ 크롬 탭에서 클릭 감지가 아직 안 켜졌어요 (크롬 위쪽에 초록 안내줄이 없으면 이 상태예요). 크롬의 그 탭을 새로고침(F5)하거나, 검색 버튼을 다시 눌러주세요.${st.pageUrl ? `<br><small class="muted">현재 탭 주소: ${esc(st.pageUrl)}</small>` : ""}${err}` : `⏳ 크롬 이미지 검색을 준비하는 중이에요...${err}`);
    }
  }
  else if (st.status === "working") pickState(i, "⏳ 이미지를 복사하는 중이에요...");
  else if (st.status === "copied") pickState(i, `✅ 복사됐어요 (${esc(st.quality)}) · ${how} · 다른 이미지로 바꾸려면 크롬의 초록 줄을 누른 뒤 클릭하세요`);
  else if (st.status === "closed" || st.status === "error") {
    pickState(i, st.file ? `✅ 복사했던 이미지예요 · 누르면 다시 복사돼요` : st.status === "error" ? `<span class="error">⚠ ${esc(st.error)}</span>` : "크롬의 이미지 검색 창이 닫혔어요. 다시 하려면 검색 버튼을 눌러주세요.");
    clearInterval(pickPoll);
  }
}

// 앱에 보이는 이미지를 누르면 그 이미지가 복사된다 → 글쓰기 창에서 Ctrl+V만 하면 된다
const netMsg = (m) => (/failed to fetch|networkerror|load failed/i.test(String(m)) ? "프로그램(서버)과 연결이 끊겼어요. 잠시 뒤 다시 눌러보고, 계속 안 되면 프로그램을 다시 실행해주세요." : String(m));
async function copyPicked(i) {
  const it = pickItems[i];
  if (!it || !it.file || it.copying) return; // 빠르게 두 번 눌러도 한 번만 처리
  it.copying = true;
  try {
    await copyPickedInner(i, it);
  } finally {
    it.copying = false;
  }
}
async function copyPickedInner(i, it) {
  try {
    const blob = await fetch(it.previewUrl).then((r) => r.blob());
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  } catch {
    const r = await fetch("/api/images/copy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: it.file }) }).then((x) => x.json()).catch((e) => ({ error: e.message }));
    if (r.error) return pickState(i, `<span class="error">⚠ ${esc(netMsg(r.error))}</span>`);
  }
  it.copiedAt = Date.now();
  pickState(i, "✅ 이 이미지를 복사했어요 · 네이버 글쓰기 창에서 넣을 자리를 누르고 <b>Ctrl+V</b>");
}

const unescapeText = (t) =>
  String(t)
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\//g, "/");
/** 글(JSON) 안의 모든 글자에서 글자 그대로 들어온 \\n 같은 표시를 정리한다 */
function cleanPostText(v) {
  if (typeof v === "string") return unescapeText(v);
  if (Array.isArray(v)) return v.map(cleanPostText);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanPostText(x)]));
  return v;
}

/**
 * 예전 구조의 글({introLines, sectionHeadingLines, sections: ["본문", …]})을 내 템플릿 자리에 맞는 구조로 바꾼다.
 * (이미 받아 둔 JSON을 내 템플릿 모드에서 쓸 때) 본문의 | 표 | 는 "칸: 칸" 줄로 풀어 쓴다.
 */
function legacyToTpl(post) {
  const clean = (t) => String(t || "").replace(/\*\*/g, "").trim();
  const firstSentence = (t) => (clean(t).split(/(?<=[.!?요다])\s+/)[0] || "").slice(0, 60);
  const secs = (post.sections || []).map((body, i) => {
    const title = clean(((post.sectionHeadingLines || [])[i] || []).join(" ")).replace(/^\d+\.\s*/, "").replace(/^[①-⑩]\s*/, "") || `${i + 1}번`;
    const lines = [];
    for (const raw of String(body || "").split("\n")) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith("|")) lines.push(l); // 표는 그대로 둔다 (저장할 때 에디터에 진짜 표로 넣는다)
      else lines.push(clean(l.replace(/^[-*•]\s+/, "• ")));
    }
    const short = lines.find((l) => !l.startsWith("•") && !l.startsWith("|")) || lines[0] || "";
    const rest = lines.filter((l) => l !== short);
    const keyword = ((title.split(/[,，!?！？]/)[0] || title).trim().split(/\s+/).slice(0, 2).join(" ")).slice(0, 12); // 소제목 자리에 들어갈 짧은 키워드
    return { title, short: short.slice(0, 80), keyword, explain: rest.join("\n") };
  });
  const title = clean(post.title);
  const last = secs[secs.length - 1];
  return {
    title,
    intro: (post.introLines || []).map(clean).join("\n"),
    shortHeading: (title.split(/[|｜]/)[0] || title).trim().slice(0, 24),
    topicLine: title.slice(0, 40),
    sections: secs,
    tocLines: secs.slice(0, 5).map((x) => x.title.slice(0, 40)),
    summaryLines: secs.slice(0, 5).map((x) => firstSentence(x.short) || x.title),
    reflection: last ? (last.explain.split("\n").filter(Boolean).slice(-1)[0] || last.short) : "",
  };
}

function loadPost(post) {
  post = cleanPostText(post); // AI가 \n 을 글자 그대로 준 경우를 정리
  // 내 템플릿 모드인데 예전 구조의 글이 오면 템플릿 구조로 바꿔서 쓴다
  if (formatInfo && formatInfo.kind === "mytpl" && post && !post.tpl && Array.isArray(post.introLines) && Array.isArray(post.sections) && typeof post.sections[0] === "string") {
    const tpl = legacyToTpl(post);
    post.tpl = tpl;
  }
  // 내 템플릿 모드의 글({intro, sections:[{title,short,keyword,explain}…]})은 미리보기·이미지용 모양으로도 바꿔 둔다 (원본은 tpl에 보관)
  if (post && typeof post.intro === "string" && Array.isArray(post.sections) && post.sections[0] && typeof post.sections[0] === "object") {
    const tpl = JSON.parse(JSON.stringify(post));
    post.tpl = tpl;
    post.introLines = [tpl.intro];
    post.sectionHeadingLines = tpl.sections.map((s) => [s.title || ""]);
    post.sections = tpl.sections.map((s) => [s.short, s.keyword ? `소제목: ${s.keyword}` : "", s.explain].filter(Boolean).join("\n"));
  }
  savedDraftOnce = false; // 새 글이면 새로 저장한다
  pickTabsClosed = false;
  // 내 형식을 저장해 쓰는 경우엔 모야ZIP 전용 네이버 템플릿을 적용하지 않는다
  if (formatInfo) $("#use-template-checkbox").checked = !!formatInfo.useTemplate;
  post.introLines = post.introLines || [];
  post.sectionHeadingLines = post.sectionHeadingLines || [];
  currentPost = post;
  selectedImagePaths = {};
  $("#post-title").value = post.title;
  renderPostPreview(post);
  renderSectionImages(post);
  $("#step-preview").hidden = false;
  setActiveStep(3);
  $("#paste-status").textContent = `✅ 불러왔어요 (섹션 ${post.sections.length}개). 네이버 블로그 글쓰기 창을 여는 중이에요... (크롬 창을 확인하세요)`;
  $("#step-preview").scrollIntoView({ behavior: "smooth" });
  $("#save-draft-btn").click();
}

document.addEventListener("click", (e) => {
  const b = e.target.closest(".chip-q");
  if (!b || !searchCtx) return;
  const q = b.dataset.q;
  $("#keyword").value = q;
  searchCtx = { ...searchCtx, keyword: q };
  renderCtxBox();
  runSearch(q, 0);
});

function renderCtxBox() {
  const box = $("#ctx-box");
  if (!searchCtx) { box.hidden = true; box.innerHTML = ""; return; }
  const qs = (searchCtx.questions || []).map((q) => `<li>${esc(q)}</li>`).join("");
  box.hidden = false;
  box.innerHTML = `<b>💡 이 주제로 쓸 글: ${esc(searchCtx.title)}</b>
    ${searchCtx.resolved
      ? `<p class="hint" style="margin:4px 0">🔎 이 주제가 잘 나오는 검색어로 찾았어요: <b id="ctx-rich">${esc(searchCtx.keyword)}</b>${searchCtx.why ? ` <span class="muted">· ${esc(searchCtx.why)}</span>` : ""}</p>
         ${(searchCtx.candidates || []).filter((q) => q !== searchCtx.keyword).length ? `<p style="margin:2px 0 6px"><small class="muted">다른 검색어로 찾기: </small>${(searchCtx.candidates || []).filter((q) => q !== searchCtx.keyword).slice(0, 5).map((q) => `<button type="button" class="chip-q" data-q="${esc(q)}">${esc(q)}</button>`).join(" ")}</p>` : ""}`
      : `<p class="hint" style="margin:4px 0">이웃 글 제목에서 뽑은 단어를 붙여 더 구체적으로 찾고 있어요: <b id="ctx-rich">${esc(searchCtx.keyword)}</b></p>`}
    ${qs ? `<p style="margin:6px 0 2px"><b>이 글에서 답해주면 좋은 질문</b></p><ul>${qs}</ul>` : ""}
    <p class="hint" style="margin:4px 0 0">이 방향과 질문은 AI에게 글을 부탁할 때 요청문에 같이 들어가요.</p>`;
}

// 이웃 소통 '주제 추천'에서 [이 주제로 글감 찾기]로 넘어온 경우: 키워드를 넣고 바로 검색
(() => {
  const kw = new URLSearchParams(location.search).get("keyword");
  if (!kw) return;
  // 아이디어 카드의 제목·질문·참고한 이웃 글을 같이 받아서 글감 찾기에 활용한다
  try {
    const c = JSON.parse(localStorage.getItem("nbh.ctx") || "null");
    localStorage.removeItem("nbh.ctx");
    if (c && c.keyword === kw) searchCtx = c;
  } catch {}
  renderCtxBox();
  $("#keyword").value = kw;
  history.replaceState(null, "", location.pathname); // 새로고침해도 다시 검색하지 않게 주소에서 지운다
  $("#search-btn").click();
})();

