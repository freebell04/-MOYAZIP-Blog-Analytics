// 크롬 탭 안에 심는 스크립트 (imagePick.js가 글자 그대로 읽어서 탭에 넣는다. 이 파일은 직접 실행하지 않는다)
// - 위쪽에 초록 안내줄을 띄우고, 클릭한 곳의 이미지를 찾아 주소를 window.__nbhPicks 에 기록한다
// - 네이버 같은 사이트는 페이지를 다시 그리거나 document.open() 으로 문서를 새로 쓰면서 우리가 넣은 안내줄·클릭 감지를 지워버릴 때가 있다.
//   그래서 "설치됨" 표시가 아니라 "안내줄이 화면에 실제로 있는지"를 기준으로 삼고, 없으면 0.8초 안에 스스로 다시 심는다.
(() => {
  const DEFAULT_MSG = "🟩 블로그 도우미: 마음에 드는 이미지를 클릭하면 자동으로 복사돼요 → 네이버 글쓰기 창에서 넣을 자리를 누르고 Ctrl+V";
  window.__nbhPicks = window.__nbhPicks || [];
  if (window.__nbhMsg === undefined) window.__nbhMsg = DEFAULT_MSG;

  const original = (u) => {
    try {
      const s = new URL(u, location.href).searchParams.get("src");
      return s ? decodeURIComponent(s) : u;
    } catch {
      return u;
    }
  };
  const big = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 60 && r.height >= 60;
  };
  const bgUrl = (el) => {
    const m = (getComputedStyle(el).backgroundImage || "").match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : "";
  };
  const findImage = (e) => {
    const els = document.elementsFromPoint(e.clientX, e.clientY);
    // 1) 클릭한 자리에 있는 img
    const img = els.find((el) => el.tagName === "IMG" && (el.naturalWidth >= 60 || big(el)));
    if (img) return { src: img.currentSrc || img.src, w: img.naturalWidth, h: img.naturalHeight };
    // 2) 배경 이미지(CSS background-image)로 그려진 사진
    for (const el of els) {
      if (el === document.documentElement || el === document.body || el.id === "__nbh_bar") continue;
      const u = bgUrl(el);
      if (u && big(el)) return { src: new URL(u, location.href).href, w: 0, h: 0 };
    }
    // 3) 클릭한 카드(주변 요소) 안에서 가장 큰 img (img가 클릭을 못 받는 경우)
    for (let n = e.target, up = 0; n && n.nodeType === 1 && up < 6; n = n.parentElement, up++) {
      const imgs = [...n.querySelectorAll("img")].filter((i) => (i.currentSrc || i.src) && big(i));
      if (imgs.length) {
        const area = (i) => i.getBoundingClientRect().width * i.getBoundingClientRect().height;
        const best = imgs.sort((a, b) => area(b) - area(a))[0];
        return { src: best.currentSrc || best.src, w: best.naturalWidth, h: best.naturalHeight };
      }
    }
    return null;
  };
  // 40초 동안 아무것도 안 고르면 앱이 부른다: 화면 위쪽(검색 결과 맨 앞)의 큰 이미지를 하나 골라 기록한다
  window.__nbhAutoPick = () => {
    const ok = [...document.images].filter((i) => {
      const r = i.getBoundingClientRect();
      const u = i.currentSrc || i.src || "";
      return r.width >= 120 && r.height >= 120 && r.bottom > 0 && u && !/logo|icon|sprite|blank|loading|profile/i.test(u);
    });
    ok.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const i = ok[0];
    if (!i) return false;
    const u = i.currentSrc || i.src;
    window.__nbhPicks.push({ src: u, original: original(u), page: location.href, w: i.naturalWidth, h: i.naturalHeight });
    window.__nbhToast("⏳ 이미지를 자동으로 골라 복사하는 중...");
    return true;
  };
  const handler = (e) => {
    if (window.__nbhLocked) return; // 한 장 복사한 뒤에는 (네이버가 클릭으로 다음 이미지로 넘겨도) 더 복사하지 않는다
    try {
      const f = findImage(e);
      if (!f || !f.src) return;
      window.__nbhPicks.push({ src: f.src, original: original(f.src), page: location.href, w: f.w, h: f.h });
      window.__nbhToast("⏳ 이미지를 복사하는 중...");
    } catch {}
  };

  const paint = (bar) => {
    bar.textContent = window.__nbhMsg;
    bar.style.background = window.__nbhOk === false ? "#e03131" : "#03c75a";
  };
  // 잠금: 한 장을 복사하면 잠겨서 이후 클릭은 무시된다. 초록 줄을 누르면 풀려서 다른 이미지로 바꿔 고를 수 있다
  window.__nbhLock = (on) => {
    window.__nbhLocked = !!on;
    const bar = document.getElementById("__nbh_bar");
    if (!bar) return;
    bar.style.pointerEvents = on ? "auto" : "none";
    bar.style.cursor = on ? "pointer" : "";
    bar.title = on ? "눌러서 잠금 해제 (다른 이미지로 바꾸고 싶을 때)" : "";
    if (on && !bar.__nbhUnlock) {
      bar.__nbhUnlock = () => { if (window.__nbhLocked) { window.__nbhLock(false); window.__nbhToast("🟩 잠금을 풀었어요 — 바꿀 이미지를 클릭하세요"); } };
      bar.addEventListener("click", bar.__nbhUnlock);
    }
  };
  window.__nbhToast = (text, ok) => {
    window.__nbhMsg = text;
    window.__nbhOk = ok;
    const bar = document.getElementById("__nbh_bar");
    if (bar) paint(bar);
  };

  // 안내줄이 없으면 (처음이거나 페이지가 지워버렸으면) 안내줄과 클릭 감지를 다시 심는다
  const ensure = () => {
    if (document.getElementById("__nbh_bar")) return;
    const bar = document.createElement("div");
    bar.id = "__nbh_bar";
    bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;color:#fff;font:600 14px/1.5 'Malgun Gothic',sans-serif;padding:9px 14px;text-align:center;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.25)";
    paint(bar);
    (document.body || document.documentElement).appendChild(bar);
    if (window.__nbhHandler) document.removeEventListener("click", window.__nbhHandler, true);
    window.__nbhHandler = handler;
    document.addEventListener("click", handler, true);
  };
  ensure();
  if (!window.__nbhTimer) window.__nbhTimer = setInterval(ensure, 800);
})()
