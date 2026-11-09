/**
 * Embedded-player fallback (inline script, emitted once per page by both render modes).
 *
 * Video platforms often restrict playback to the original site's domains (Kaltura access control on ibm.com: the
 * player answers SITE_RESTRICTED, "This content is unavailable in this domain"). On the migrated domain such a player
 * renders nothing: an empty poster under a hidden error overlay, i.e. a blank hero. Visitors with
 * prefers-reduced-motion never notice, the player stays on its thumbnail; everyone else sees a hole.
 *
 * When a player reports an error, this script shows what the original shows before playback starts:
 *  1. a web-component player with its own thumbnail state (`content-state`, Carbon for IBM.com <c4d-video-player>)
 *     is switched back to it: identical to the reduced-motion rendering, play button included;
 *  2. otherwise the nearest poster/thumbnail URL (video[poster], poster / thumbnail-url / data-poster / data-thumbnail
 *     attributes up the tree) is painted over the player box, and the error overlay is hidden.
 *
 * Every rescued player is marked `data-cmp-player-fallback="thumbnail|poster|none"` (+ `data-cmp-player-error` with
 * the player's message) so verify's playback check can tell a covered player from a blank one. The playback
 * restriction itself stays a migration task (allow the new domain on the video platform); nothing here works around it.
 */
export const PLAYER_FALLBACK_JS = `(function () {
  if (window.__cmpPlayerFallback) return;
  window.__cmpPlayerFallback = true;
  var MARK = "data-cmp-player-fallback";
  var ERROR_SEL = ".playkit-error-overlay.playkit-active, .video-js.vjs-error, .jw-state-error";
  var BOX_SEL = ".playkit-player, .video-js, .jwplayer";
  var POSTER_ATTRS = ["poster", "data-poster", "data-poster-url", "thumbnail-url", "data-thumbnail", "data-thumbnail-url"];
  var up = function (n) {
    if (n.parentElement) return n.parentElement;
    var r = n.getRootNode && n.getRootNode();
    return r && r.host ? r.host : null;
  };
  var errorText = function (el) {
    var m = el.querySelector && el.querySelector(".playkit-error-message, .vjs-modal-dialog-content, .jw-error-text");
    var t = ((m && m.textContent) || (el.error && el.error.message) || "").replace(/\\s+/g, " ").trim();
    return t.slice(0, 200);
  };
  var rescue = function (el) {
    var host = null, poster = null, mark = null;
    if (el.tagName === "VIDEO" && el.getAttribute("poster")) poster = el.getAttribute("poster");
    for (var n = el, i = 0; n && i < 15; n = up(n), i++) {
      if (!n.getAttribute) continue;
      if (!host && n.tagName.indexOf("-") > 0 && n.hasAttribute("content-state")) host = n;
      for (var a = 0; !poster && a < POSTER_ATTRS.length; a++) {
        var v = n.getAttribute(POSTER_ATTRS[a]);
        if (v && /^(https?:)?\\/\\/|^\\//.test(v)) poster = v;
      }
    }
    if (host) {
      if (host.getAttribute("content-state") !== "thumbnail") {
        try { host.contentState = "thumbnail"; } catch (e) {}
        if (host.getAttribute("content-state") !== "thumbnail") host.setAttribute("content-state", "thumbnail");
      }
      mark = host;
      mark.setAttribute(MARK, "thumbnail");
    } else {
      var box = (el.closest && el.closest(BOX_SEL)) || (el.tagName === "VIDEO" ? el.parentElement : el);
      if (!box) return;
      mark = box;
      if (poster && !box.querySelector("img[" + MARK + "]")) {
        if (getComputedStyle(box).position === "static") box.style.position = "relative";
        var img = document.createElement("img");
        img.setAttribute(MARK, "");
        img.alt = "";
        img.src = poster;
        img.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:1;pointer-events:none";
        box.appendChild(img);
        if (el.classList && el.classList.contains("playkit-error-overlay")) el.style.display = "none";
      }
      box.setAttribute(MARK, poster ? "poster" : "none");
    }
    var msg = errorText(el);
    if (msg) mark.setAttribute("data-cmp-player-error", msg);
  };
  var scan = function () {
    var els = document.querySelectorAll(ERROR_SEL);
    for (var i = 0; i < els.length; i++) {
      try { rescue(els[i]); } catch (e) {}
    }
  };
  var queued = false;
  var schedule = function () {
    if (queued) return;
    queued = true;
    setTimeout(function () { queued = false; scan(); }, 50);
  };
  // <video>/<source> errors do not bubble: listen in the capture phase
  document.addEventListener("error", function (ev) {
    var t = ev.target;
    var v = t && t.tagName === "SOURCE" ? t.parentElement : t;
    if (!v || v.tagName !== "VIDEO") return;
    if (t !== v && v.networkState !== 3) return; // another <source> may still play
    if (v.getAttribute("poster")) return; // the browser keeps showing the poster
    try { rescue(v); } catch (e) {}
  }, true);
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  } catch (e) {}
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan); else scan();
})();`;
