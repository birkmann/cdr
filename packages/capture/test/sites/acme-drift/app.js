// Fixture behaviour: drawer menu with one drill-down level, carousel arrows, consent banner, a shadow-DOM badge.
(() => {
  const toggle = document.querySelector(".nav-toggle");
  const menu = document.getElementById("menu");
  const levels = [...menu.querySelectorAll(".menu-level")];
  const show = (name) => levels.forEach((l) => (l.hidden = l.dataset.level !== name));
  const open = () => {
    menu.hidden = false;
    show("root");
    toggle.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.querySelectorAll(".menu-close").forEach((b) => b.addEventListener("click", close));
  menu.querySelectorAll(".menu-entry").forEach((b) =>
    b.addEventListener("click", () => {
      show(b.dataset.sub);
      b.setAttribute("aria-expanded", "true");
    }),
  );
  menu.querySelectorAll(".menu-back").forEach((b) => b.addEventListener("click", () => show("root")));

  const track = document.querySelector(".carousel-track");
  const step = () => track.querySelector(".slide").getBoundingClientRect().width + 16;
  document.querySelector(".carousel-next").addEventListener("click", () => track.scrollBy({ left: step(), behavior: "smooth" }));
  document.querySelector(".carousel-prev").addEventListener("click", () => track.scrollBy({ left: -step(), behavior: "smooth" }));

  document.querySelector(".consent-accept").addEventListener("click", () => document.querySelector(".consent").remove());

  customElements.define(
    "acme-badge",
    class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML =
          '<style>span{display:inline-block;padding:4px 12px;border-radius:999px;background:#0f5132;color:#fff;font-weight:600;font-size:14px}</style><span><slot></slot></span>';
      }
    },
  );
})();
