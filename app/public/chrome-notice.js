// 크롬(네이버) 창이 열릴 때마다 "주황빛을 확인해주세요" 안내를 띄운다.
// 윈도우는 뒤에 있던 창이 앞으로 나오려 하면 포커스를 뺏지 않고 작업 표시줄 아이콘을 주황색으로 깜빡인다.
// 서버(/api/chrome-notice)의 id가 바뀔 때마다(= 크롬 창이 열리거나 앞으로 나올 때마다) 새로 보여준다.
(function () {
  if (location.protocol === "file:") return;
  let lastId = null;
  let hideTimer = null;
  let box = null;

  function show(reason) {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText =
        "position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:99997;max-width:min(460px,calc(100vw - 24px));width:100%;" +
        "background:#fff7ed;border:2px solid #fb923c;border-radius:14px;padding:14px 16px;box-shadow:0 8px 24px rgba(251,146,60,.35);" +
        "font-family:'Noto Sans KR',system-ui,sans-serif;display:none;gap:12px;align-items:flex-start;";
      document.body.appendChild(box);
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    box.innerHTML =
      '<div style="font-size:26px;line-height:1">🟧</div>' +
      '<div style="flex:1;min-width:0">' +
      '<div style="font-weight:700;font-size:15px;color:#9a3412;margin-bottom:3px">크롬 화면이 열렸어요</div>' +
      '<div style="font-size:13.5px;color:#7c2d12;line-height:1.6">윈도우 <b>탭 창(작업 표시줄)</b>에서 <b>주황빛</b>을 확인해주세요.' +
      (reason ? '<div style="margin-top:2px;color:#c2410c;font-size:12.5px">열린 창: ' + esc(reason) + "</div>" : "") +
      "</div></div>" +
      '<button id="cn-close" aria-label="닫기" style="border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#9a3412;padding:0 2px">×</button>';
    // (인라인 display:flex 때문에 hidden 속성이 안 먹으므로 display로 직접 숨긴다)
    const hide = () => { box.style.display = "none"; clearTimeout(hideTimer); };
    box.style.display = "flex";
    box.style.cursor = "pointer";
    box.title = "눌러서 닫기";
    box.onclick = hide; // × 버튼이든 카드 어디든 누르면 닫힌다
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 25000); // 25초 뒤 저절로 닫힘 (다시 열리면 또 뜬다)
  }

  async function poll() {
    try {
      const n = await fetch("/api/chrome-notice", { cache: "no-store" }).then((r) => r.json());
      if (lastId === null) {
        // 화면을 처음 열었을 때: 방금(20초 안에) 열린 창이면 보여주고, 아니면 기준만 잡는다
        lastId = n.id;
        if (n.id && Date.now() - n.at < 20000) show(n.reason);
      } else if (n.id !== lastId) {
        lastId = n.id;
        show(n.reason);
      }
    } catch {}
  }
  poll();
  setInterval(poll, 1500);
})();
