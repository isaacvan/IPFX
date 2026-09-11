(function () {
  "use strict";

  var CONSENT_KEY = "ipfx_cookie_consent_v1";
  var main = document.querySelector("main, [role='main']");
  function resolveMain() {
    if (main) return main;
    var heading = document.querySelector("h1");
    main = heading && (heading.closest(".page-container, .content-wrapper, .wrap, .container, .hero") || heading.parentElement);
    if (main) main.setAttribute("role", "main");
    return main;
  }

  function addSkipLink() {
    main = resolveMain();
    if (!main || document.querySelector(".ipfx-skip-link")) return;
    if (!main.id) main.id = "main-content";
    var link = document.createElement("a");
    link.className = "ipfx-skip-link";
    link.href = "#" + main.id;
    link.textContent = "Skip to main content";
    document.body.insertBefore(link, document.body.firstChild);
  }

  function hardenLinks() {
    document.querySelectorAll('a[target="_blank"]').forEach(function (link) {
      var rel = new Set((link.getAttribute("rel") || "").split(/\s+/).filter(Boolean));
      rel.add("noopener");
      rel.add("noreferrer");
      link.setAttribute("rel", Array.from(rel).join(" "));
    });
  }

  function improveMedia() {
    document.querySelectorAll("img").forEach(function (image, index) {
      image.decoding = "async";
      if (index > 1 && !image.hasAttribute("loading")) image.loading = "lazy";
    });
  }

  function improveFaq() {
    document.querySelectorAll(".faq-question, .faq-q").forEach(function (control, index) {
      if (control.tagName !== "BUTTON") {
        control.setAttribute("role", "button");
        control.setAttribute("tabindex", "0");
      }
      var item = control.closest(".faq-item, .faq-item-minimal");
      var answer = item && item.querySelector(".faq-answer, .faq-a");
      if (!answer) return;
      if (!answer.id) answer.id = "faq-answer-" + index;
      control.setAttribute("aria-controls", answer.id);
      var expanded = item.classList.contains("open") || item.classList.contains("active");
      control.setAttribute("aria-expanded", String(expanded));
      var sync = function () {
        requestAnimationFrame(function () {
          var isOpen = item.classList.contains("open") || item.classList.contains("active") ||
            control.classList.contains("open");
          control.setAttribute("aria-expanded", String(isOpen));
        });
      };
      control.addEventListener("click", sync);
      if (control.tagName !== "BUTTON") {
        control.addEventListener("keydown", function (event) {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            control.click();
          }
        });
      }
    });
  }

  function enableShare() {
    document.querySelectorAll("[data-ipfx-share]").forEach(function (button) {
      button.addEventListener("click", function () {
        var data = { title: document.title, text: document.querySelector('meta[name="description"]')?.content || "", url: location.href };
        if (navigator.share) {
          navigator.share(data).catch(function () {});
        } else {
          var copied = navigator.clipboard && window.isSecureContext
            ? navigator.clipboard.writeText(location.href)
            : Promise.reject(new Error("Clipboard unavailable"));
          copied.then(function () {
            var original = button.textContent;
            button.textContent = "Link copied";
            button.setAttribute("aria-live", "polite");
            setTimeout(function () { button.textContent = original; }, 1800);
          }).catch(function () {
            window.prompt("Copy this page link", location.href);
          });
        }
      });
    });
  }

  function loadAnalytics() {
    if (document.querySelector("script[data-ipfx-analytics]")) return;
    var config = window.IPFX_ANALYTICS;
    if (!config || !config.src || !config.domain) return;
    var script = document.createElement("script");
    script.defer = true;
    script.src = config.src;
    script.dataset.domain = config.domain;
    script.dataset.ipfxAnalytics = "true";
    document.head.appendChild(script);
  }

  function saveConsent(value) {
    try { localStorage.setItem(CONSENT_KEY, JSON.stringify({
      essential: true,
      analytics: value === "analytics",
      decidedAt: new Date().toISOString(),
      version: 1
    })); } catch (_) { /* The current-page choice still applies when storage is unavailable. */ }
    if (value === "analytics") loadAnalytics();
    panel.hidden = true;
    preferences.hidden = false;
    preferences.focus();
    window.dispatchEvent(new CustomEvent("ipfx:consent", { detail: { analytics: value === "analytics" } }));
  }

  var panel = document.createElement("section");
  panel.className = "ipfx-cookie-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "ipfx-cookie-title");
  panel.innerHTML =
    '<h2 id="ipfx-cookie-title">Your privacy choices</h2>' +
    '<p>We use essential storage for security and account sessions. Optional analytics only loads after you agree. ' +
    '<a href="/privacy.html#cookies">Read our cookie information</a>.</p>' +
    '<div class="ipfx-cookie-actions">' +
    '<button type="button" data-consent="essential">Essential only</button>' +
    '<button type="button" data-consent="analytics">Accept analytics</button>' +
    '</div>';

  var preferences = document.createElement("button");
  preferences.type = "button";
  preferences.className = "ipfx-cookie-preferences";
  preferences.textContent = "Cookie settings";
  preferences.hidden = true;
  preferences.addEventListener("click", function () {
    panel.hidden = false;
    preferences.hidden = true;
    panel.querySelector("button").focus();
  });

  panel.addEventListener("click", function (event) {
    var button = event.target.closest("[data-consent]");
    if (button) saveConsent(button.dataset.consent);
  });

  document.addEventListener("DOMContentLoaded", function () {
    addSkipLink();
    hardenLinks();
    improveMedia();
    improveFaq();
    enableShare();
    document.body.appendChild(panel);
    (document.querySelector(".ipfx-launch-footer") || document.body).appendChild(preferences);
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem(CONSENT_KEY)); } catch (_) {}
    if (!stored) {
      panel.hidden = false;
    } else {
      preferences.hidden = false;
      if (stored.analytics) loadAnalytics();
    }
  });
}());
