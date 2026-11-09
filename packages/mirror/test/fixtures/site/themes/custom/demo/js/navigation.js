/* Demo theme — mobile navigation toggle. */
(function () {
  "use strict";
  var button = document.querySelector("[data-drupal-selector='mobile-nav-button']");
  var nav = document.getElementById("header-nav");
  if (!button || !nav) return;
  button.addEventListener("click", function () {
    var open = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!open));
    nav.classList.toggle("is-active", !open);
  });
})();
