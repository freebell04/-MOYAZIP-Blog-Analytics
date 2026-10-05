// 무료 체험 후기 설문 안내 창 (체험 3일째·7일째·마지막 날). 띄울지 말지는 서버(/api/survey)가 정한다.
(function () {
  if (location.protocol === "file:") return;
  fetch("/api/survey" + (/[?&]survey=(3|7|14)/.test(location.search) ? "?preview=" + location.search.match(/[?&]survey=(\d+)/)[1] : ""))
    .then((r) => r.json())
    .then((p) => {
      if (!p || !p.show) return;
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;inset:0;z-index:99998;background:rgba(20,20,20,.5);display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Noto Sans KR',system-ui,sans-serif;";
      const title = p.last ? "오늘이 무료 체험 마지막 날이에요" : `무료 체험 ${p.milestone}일째예요`;
      const msg = p.last
        ? "2주 동안 써보셔서 감사해요 🙏<br>1~2분이면 끝나는 후기 설문에 참여해 주시면 앞으로 더 좋게 만들어 갈게요."
        : p.milestone >= 7
          ? "벌써 일주일을 써보셨네요 🙌<br>써보신 느낌을 1~2분 설문으로 들려주세요."
          : "써보시니 어떠세요?<br>불편한 점이나 바라는 점을 1~2분 설문으로 알려주세요.";
      const btn = "border:0;border-radius:10px;padding:11px 18px;font-size:14px;font-weight:700;cursor:pointer;";
      box.innerHTML = `
        <div style="background:#fff;border-radius:16px;max-width:400px;width:100%;padding:26px 24px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.2)">
          <div style="font-size:34px;margin-bottom:6px">📝</div>
          <h2 style="margin:0 0 8px;font-size:17px;color:#1a1a1a">${title}</h2>
          <p style="margin:0 0 18px;font-size:13.5px;color:#5b5b5b;line-height:1.7">${msg}</p>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
            <button id="sv-open" style="${btn}background:#03c75a;color:#fff">설문 참여하기</button>
            <button id="sv-skip" style="${btn}background:#f1f3f5;color:#495057">${p.canLater ? "나중에" : "닫기"}</button>
          </div>
        </div>`;
      document.body.appendChild(box);
      const send = (action) => p.preview ? Promise.resolve() : fetch("/api/survey", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => {});
      box.querySelector("#sv-open").onclick = () => {
        send("open");
        window.open(p.url, "_blank", "noopener");
        box.remove();
      };
      box.querySelector("#sv-skip").onclick = () => {
        send(p.canLater ? "later" : "close");
        box.remove();
      };
    })
    .catch(() => {});
})();
