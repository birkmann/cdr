/* Demo theme — cookie consent banner. Shows #cookie-banner until a choice is stored. */
(function () {
  "use strict";
  var KEY = "demo-cookie-consent";
  var banner = document.getElementById("cookie-banner");
  if (!banner) return;
  var choice = null;
  try {
    choice = window.localStorage.getItem(KEY);
  } catch (e) {
    choice = null;
  }
  if (!choice) banner.hidden = false;
  banner.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || !target.getAttribute) return;
    var value = target.getAttribute("data-cookie-choice");
    if (!value) return;
    try {
      window.localStorage.setItem(KEY, value);
    } catch (e) {
      /* private mode: just hide */
    }
    banner.hidden = true;
  });
})();
