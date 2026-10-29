// 무료 체험이 3일 이하로 남았을 때 화면 위에 결제 안내 줄을 띄운다. 띄울지 말지는 서버(/api/license/buy)가 정한다 (구매한 키에는 안 뜬다).
// [×]를 누르면 그날은 다시 안 띄운다.
(function () {
  if (location.protocol === "file:") return;
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  try { if (localStorage.getItem("nbh-buy-hide") === today) return; } catch {}
  fetch("/api/license/buy")
    .then((r) => r.json())
    .then((b) => {
      if (!b || !b.show || b.expired) return;
      const bar = document.createElement("div");
      bar.style.cssText = "position:sticky;top:0;z-index:9999;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap;padding:9px 14px;background:#f0fdf4;border-bottom:1.5px solid #03c75a;font-family:'Noto Sans KR',system-ui,sans-serif;font-size:13.5px;color:#14532d;";
      const left = b.daysLeft <= 1 ? "오늘이 무료 체험 마지막 날이에요" : `무료 체험이 ${b.daysLeft}일 남았어요`;
      bar.innerHTML = `<span>🎁 <b>${left}</b> · ${b.price} 한 번 결제하면 계속 쓸 수 있어요 (다시 설치할 필요 없어요)</span>
        <a href="${b.url}" target="_blank" rel="noopener" style="background:#03c75a;color:#fff;border-radius:8px;padding:6px 12px;font-weight:700;text-decoration:none">계속 쓰기</a>
        <button type="button" aria-label="오늘은 그만 보기" style="border:0;background:none;font-size:16px;cursor:pointer;color:#6b7280">×</button>`;
      bar.querySelector("button").addEventListener("click", () => {
        try { localStorage.setItem("nbh-buy-hide", today); } catch {}
        bar.remove();
      });
      document.body.prepend(bar);
    })
    .catch(() => {});
})();
