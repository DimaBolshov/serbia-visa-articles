(() => {
  const plural = (n, forms) => {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    return a > 10 && a < 20 ? forms[2] : b > 1 && b < 5 ? forms[1] : b === 1 ? forms[0] : forms[2];
  };

  // Поиск по карточкам на главной
  const input = document.getElementById("q");
  if (input) {
    const cards = [...document.querySelectorAll(".card")];
    const count = document.getElementById("count");
    const empty = document.getElementById("empty");
    const apply = () => {
      const terms = input.value.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const card of cards) {
        const ok = terms.every((t) => card.dataset.search.includes(t));
        card.hidden = !ok;
        if (ok) shown++;
      }
      count.textContent = terms.length
        ? `Найдено: ${shown} из ${cards.length}`
        : `${cards.length} ${plural(cards.length, ["статья", "статьи", "статей"])}`;
      empty.hidden = shown !== 0;
    };
    input.addEventListener("input", apply);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.value = "";
        apply();
      }
    });
    apply();
  }

  // Подсветка текущего раздела в боковом содержании
  const links = [...document.querySelectorAll(".toc-side a[href^='#']")];
  if (links.length) {
    const byId = new Map(links.map((a) => [decodeURIComponent(a.getAttribute("href").slice(1)), a]));
    const heads = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
    const groups = [...document.querySelectorAll(".toc-side li.group")];
    let queued = false;
    const update = () => {
      queued = false;
      let current = heads[0];
      for (const h of heads) {
        if (h.getBoundingClientRect().top <= 120) current = h;
        else break;
      }
      const active = byId.get(current.id);
      links.forEach((a) => a.classList.toggle("on", a === active));
      groups.forEach((li) => li.classList.toggle("active", !!li.querySelector("a.on")));
    };
    addEventListener(
      "scroll",
      () => {
        if (!queued) {
          queued = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true },
    );
    update();
  }
})();
