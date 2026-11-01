(function globalCourtEnhancements() {
  "use strict";

  const pagePath = window.location.pathname || "/";
  const manualStateKey = "globalCourtManualState:" + pagePath;
  const panelStateKey = "globalCourtPanelOpen:" + pagePath;

  const manualChecks = [
    { label: "The opening states a clear result for the reader.", points: 10 },
    { label: "Each section includes one concrete example.", points: 10 },
    { label: "Claims include supporting data, proof, or links.", points: 10 },
    { label: "The page ends with a clear next action.", points: 10 },
    { label: "Final proofreading is complete.", points: 10 }
  ];

  const autoChecks = [
    { label: "Meta description is present and useful.", points: 10, run: checkMetaDescription },
    { label: "Heading structure is clear.", points: 10, run: checkHeadingStructure },
    { label: "Images include alt text.", points: 10, run: checkImageAltCoverage },
    { label: "Form fields have accessible labels.", points: 10, run: checkFormLabels },
    { label: "Main content landmark exists.", points: 10, run: checkMainLandmark }
  ];

  let widget = null;
  let refreshTimer = null;
  let observer = null;

  function safeReadArray(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(Number.isInteger);
      if (parsed && Array.isArray(parsed.manual)) return parsed.manual.filter(Number.isInteger);
      return [];
    } catch (error) {
      return [];
    }
  }

  function safeReadBoolean(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return raw === "true";
    } catch (error) {
      return fallback;
    }
  }

  function persistArray(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      return;
    }
  }

  function persistBoolean(key, value) {
    try {
      localStorage.setItem(key, String(Boolean(value)));
    } catch (error) {
      return;
    }
  }

  function isLabelCandidate(field) {
    if (!field || field.closest(".gp-court-shell")) return false;
    const tag = field.tagName.toLowerCase();
    if (tag === "select" || tag === "textarea") return true;
    if (tag !== "input") return false;
    const type = (field.getAttribute("type") || "text").toLowerCase();
    return !["hidden", "submit", "button", "reset", "image"].includes(type);
  }

  function hasAccessibleLabel(field) {
    if (!field) return false;
    if (field.hasAttribute("aria-label") || field.hasAttribute("aria-labelledby")) return true;
    if (field.closest("label")) return true;
    if (field.id && document.querySelector('label[for="' + field.id + '"]')) return true;
    return false;
  }

  function findMainTarget() {
    const selectors = [
      "main",
      "[role='main']",
      "#main-content",
      "#mainContent",
      "article",
      ".page-wrap",
      ".blog-view",
      ".post",
      ".container"
    ];

    for (const selector of selectors) {
      const target = document.querySelector(selector);
      if (target && !target.closest(".gp-court-shell")) return target;
    }
    return null;
  }

  function ensureMainLandmark() {
    const target = findMainTarget();
    if (!target) return null;

    if (!target.id) target.id = "main-content";
    if (target.tagName.toLowerCase() !== "main" && !target.hasAttribute("role")) {
      target.setAttribute("role", "main");
    }

    return target;
  }

  function ensureSkipLink() {
    if (document.querySelector(".skip-link")) return;

    const mainTarget = ensureMainLandmark();
    if (!mainTarget || !document.body) return;

    const skip = document.createElement("a");
    skip.className = "skip-link gp-court-skip-link";
    skip.href = "#" + mainTarget.id;
    skip.textContent = "Skip to main content";
    document.body.insertBefore(skip, document.body.firstChild);
  }

  function hardenExternalLinks() {
    const links = document.querySelectorAll('a[target="_blank"]');
    links.forEach((link) => {
      const rel = (link.getAttribute("rel") || "").trim();
      if (!/noopener/i.test(rel) || !/noreferrer/i.test(rel)) {
        link.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  function optimizeImages() {
    const images = document.querySelectorAll("img");
    images.forEach((img) => {
      if (!img.hasAttribute("loading")) img.setAttribute("loading", "lazy");
      if (!img.hasAttribute("decoding")) img.setAttribute("decoding", "async");
      if (!img.hasAttribute("referrerpolicy")) img.setAttribute("referrerpolicy", "no-referrer");
    });
  }

  function normalizeButtonTypes() {
    const buttons = document.querySelectorAll("button:not([type])");
    buttons.forEach((button) => {
      if (!button.closest("form")) button.type = "button";
    });
  }

  function promotePlaceholdersToAria() {
    const fields = document.querySelectorAll("input, textarea, select");
    fields.forEach((field) => {
      if (!isLabelCandidate(field) || hasAccessibleLabel(field)) return;
      const placeholder = (field.getAttribute("placeholder") || "").trim();
      if (placeholder) field.setAttribute("aria-label", placeholder);
    });
  }

  function enhanceHamburgerAccess() {
    const controls = document.querySelectorAll(".hamburger");
    controls.forEach((control) => {
      if (!control.hasAttribute("aria-label")) {
        control.setAttribute("aria-label", "Toggle navigation");
      }

      if (control.tagName.toLowerCase() === "button") return;

      control.setAttribute("role", "button");
      if (!control.hasAttribute("tabindex")) control.setAttribute("tabindex", "0");

      if (control.dataset.gpCourtKeyHandler === "true") return;

      control.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          control.click();
        }
      });
      control.dataset.gpCourtKeyHandler = "true";
    });
  }

  function applyAutomaticImprovements() {
    ensureMainLandmark();
    ensureSkipLink();
    hardenExternalLinks();
    optimizeImages();
    normalizeButtonTypes();
    promotePlaceholdersToAria();
    enhanceHamburgerAccess();
  }

  function checkMetaDescription() {
    const meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      return { pass: false, detail: "Add a meta description between 70 and 160 characters." };
    }

    const content = (meta.getAttribute("content") || "").trim();
    const length = content.length;
    const pass = length >= 70 && length <= 160;

    if (pass) {
      return { pass: true, detail: "Meta description length looks good (" + length + " chars)." };
    }

    if (!length) {
      return { pass: false, detail: "Meta description is empty." };
    }

    return { pass: false, detail: "Meta description is " + length + " chars; keep it 70-160." };
  }

  function checkHeadingStructure() {
    const h1Count = document.querySelectorAll("h1").length;
    const subheadCount = document.querySelectorAll("h2, h3").length;
    const pass = h1Count === 1 && subheadCount >= 1;

    if (pass) {
      return { pass: true, detail: "Found one H1 and " + subheadCount + " supporting subheads." };
    }

    if (h1Count === 0) {
      return { pass: false, detail: "Add a single H1 title to anchor the page." };
    }

    if (h1Count > 1) {
      return { pass: false, detail: "Use only one H1. Current count: " + h1Count + "." };
    }

    return { pass: false, detail: "Add H2/H3 subheads to improve scanability." };
  }

  function checkImageAltCoverage() {
    const images = Array.from(document.querySelectorAll("img")).filter((img) => !img.closest(".gp-court-shell"));
    if (!images.length) {
      return { pass: true, detail: "No images on this page." };
    }

    const missingAlt = images.filter((img) => !(img.getAttribute("alt") || "").trim()).length;
    const pass = missingAlt === 0;

    if (pass) {
      return { pass: true, detail: "All " + images.length + " images include alt text." };
    }

    return {
      pass: false,
      detail: missingAlt + " of " + images.length + " images are missing alt text."
    };
  }

  function checkFormLabels() {
    const fields = Array.from(document.querySelectorAll("input, textarea, select")).filter(isLabelCandidate);
    if (!fields.length) {
      return { pass: true, detail: "No form fields detected on this page." };
    }

    const unlabeled = fields.filter((field) => !hasAccessibleLabel(field)).length;
    const pass = unlabeled === 0;

    if (pass) {
      return { pass: true, detail: "All " + fields.length + " form fields have accessible labels." };
    }

    return {
      pass: false,
      detail: unlabeled + " form fields need labels or aria-label attributes."
    };
  }

  function checkMainLandmark() {
    const main = document.querySelector("main, [role='main'], #main-content, #mainContent");
    if (!main) {
      return { pass: false, detail: "Add a main landmark to define primary content." };
    }
    return { pass: true, detail: "Main content landmark detected." };
  }

  function computeVerdict(score, failedCount) {
    if (score >= 85 && failedCount <= 1) return "Verdict: ready to publish.";
    if (score >= 70) return "Verdict: almost ready, polish the weak spots.";
    if (score >= 50) return "Verdict: revise key sections before publishing.";
    return "Verdict: major improvement needed before publishing.";
  }

  function createElement(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (typeof text === "string") node.textContent = text;
    return node;
  }

  function updateManualStyles() {
    const items = widget.manualList.querySelectorAll(".gp-court-item");
    items.forEach((item) => {
      const input = item.querySelector("input[type='checkbox']");
      if (!input) return;
      item.classList.toggle("pass", input.checked);
      item.classList.toggle("fail", !input.checked);
    });
  }

  function renderAutoChecks(results) {
    widget.autoList.innerHTML = "";

    results.forEach((result) => {
      const row = createElement("li", "gp-court-item " + (result.pass ? "pass" : "fail"));

      const check = createElement("div", "gp-court-check");
      const icon = createElement("span", "gp-court-icon", result.pass ? "OK" : "!");
      icon.setAttribute("aria-hidden", "true");

      const copy = createElement("div", "gp-court-copy");
      const label = createElement("strong", "gp-court-label", result.label);
      const detail = createElement("span", "gp-court-detail", result.detail);

      copy.appendChild(label);
      copy.appendChild(detail);
      check.appendChild(icon);
      check.appendChild(copy);

      const points = createElement("span", "gp-court-pill", result.pass ? "+" + result.points : "Fix");
      row.appendChild(check);
      row.appendChild(points);

      widget.autoList.appendChild(row);
    });
  }

  function renderTips(autoResults, manualSelected) {
    widget.tips.innerHTML = "";

    const tips = [];
    const failedAuto = autoResults.filter((result) => !result.pass);
    failedAuto.forEach((result) => tips.push(result.detail));

    const remainingManual = manualChecks.length - manualSelected.length;
    if (remainingManual > 0) {
      tips.push("Complete the remaining " + remainingManual + " manual checklist item(s).");
    }

    if (!tips.length) {
      tips.push("Strong page quality across automated and manual checks.");
    }

    tips.slice(0, 3).forEach((tip) => {
      const li = createElement("li", "", tip);
      widget.tips.appendChild(li);
    });
  }

  function updateCourt() {
    if (!widget) return;

    const autoResults = autoChecks.map((check) => {
      const output = check.run();
      return {
        label: check.label,
        points: check.points,
        pass: Boolean(output && output.pass),
        detail: output && output.detail ? output.detail : "Review this area."
      };
    });

    renderAutoChecks(autoResults);

    const manualInputs = Array.from(widget.manualList.querySelectorAll("input[type='checkbox']"));
    const manualSelected = [];
    let manualScore = 0;

    manualInputs.forEach((input, index) => {
      if (!input.checked) return;
      manualSelected.push(index);
      manualScore += Number(input.dataset.points || 0);
    });

    updateManualStyles();
    persistArray(manualStateKey, manualSelected);

    const autoScore = autoResults.reduce((sum, result) => {
      return sum + (result.pass ? result.points : 0);
    }, 0);

    const totalScore = Math.min(100, autoScore + manualScore);
    const failedChecks = autoResults.filter((result) => !result.pass).length + (manualChecks.length - manualSelected.length);

    widget.score.textContent = totalScore + " / 100";
    widget.bar.style.width = totalScore + "%";
    widget.verdict.textContent = computeVerdict(totalScore, failedChecks);
    renderTips(autoResults, manualSelected);
  }

  function setPanelOpen(open) {
    if (!widget) return;
    widget.panel.hidden = !open;
    widget.toggle.setAttribute("aria-expanded", String(open));
    persistBoolean(panelStateKey, open);
  }

  function mountWidget() {
    if (!document.body || document.querySelector(".gp-court-shell")) return;

    const shell = createElement("section", "gp-court-shell");
    shell.setAttribute("aria-label", "Additional court widget");

    const toggle = createElement("button", "gp-court-toggle", "Additional Court");
    toggle.type = "button";
    toggle.id = "gpCourtToggle";
    toggle.setAttribute("aria-controls", "gpCourtPanel");

    const panel = createElement("div", "gp-court-panel");
    panel.id = "gpCourtPanel";
    panel.hidden = true;

    const head = createElement("div", "gp-court-head");
    const heading = createElement("h3", "", "Global Court");
    const score = createElement("span", "gp-court-score", "0 / 100");
    head.appendChild(heading);
    head.appendChild(score);

    const body = createElement("div", "gp-court-body");
    const intro = createElement("p", "gp-court-intro", "Quick quality review for this page.");
    const meter = createElement("div", "gp-court-meter");
    const bar = createElement("span", "");
    meter.appendChild(bar);

    const sections = createElement("div", "gp-court-sections");

    const autoBlock = createElement("section", "gp-court-block");
    autoBlock.appendChild(createElement("h4", "", "Auto checks"));
    const autoList = createElement("ul", "gp-court-list");
    autoBlock.appendChild(autoList);

    const manualBlock = createElement("section", "gp-court-block");
    manualBlock.appendChild(createElement("h4", "", "Manual checks"));
    const manualList = createElement("ul", "gp-court-list");

    const savedManual = safeReadArray(manualStateKey);

    manualChecks.forEach((item, index) => {
      const row = createElement("li", "gp-court-item gp-court-manual fail");
      const check = createElement("div", "gp-court-check");

      const input = document.createElement("input");
      input.type = "checkbox";
      input.id = "gpCourtManual" + index;
      input.dataset.points = String(item.points);
      input.checked = savedManual.includes(index);

      const label = createElement("label", "", item.label);
      label.setAttribute("for", input.id);

      check.appendChild(input);
      check.appendChild(label);

      const points = createElement("span", "gp-court-pill", "Manual");
      row.appendChild(check);
      row.appendChild(points);
      manualList.appendChild(row);
    });

    manualBlock.appendChild(manualList);
    sections.appendChild(autoBlock);
    sections.appendChild(manualBlock);

    const verdict = createElement("p", "gp-court-verdict", "");
    const tips = createElement("ul", "gp-court-tips");

    const actions = createElement("div", "gp-court-actions");
    const recheckBtn = createElement("button", "", "Recheck");
    recheckBtn.type = "button";
    const focusBtn = createElement("button", "", "Focus Main");
    focusBtn.type = "button";
    const topBtn = createElement("button", "", "Scroll Top");
    topBtn.type = "button";

    actions.appendChild(recheckBtn);
    actions.appendChild(focusBtn);
    actions.appendChild(topBtn);

    body.appendChild(intro);
    body.appendChild(meter);
    body.appendChild(sections);
    body.appendChild(verdict);
    body.appendChild(tips);
    body.appendChild(actions);

    panel.appendChild(head);
    panel.appendChild(body);
    shell.appendChild(toggle);
    shell.appendChild(panel);
    document.body.appendChild(shell);

    widget = {
      shell,
      toggle,
      panel,
      autoList,
      manualList,
      score,
      bar,
      verdict,
      tips
    };

    toggle.addEventListener("click", () => {
      setPanelOpen(panel.hidden);
    });

    manualList.querySelectorAll("input[type='checkbox']").forEach((input) => {
      input.addEventListener("change", updateCourt);
    });

    recheckBtn.addEventListener("click", () => {
      applyAutomaticImprovements();
      updateCourt();
    });

    focusBtn.addEventListener("click", () => {
      const target = ensureMainLandmark();
      if (!target) return;
      if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      window.setTimeout(() => {
        target.focus({ preventScroll: true });
      }, 150);
    });

    topBtn.addEventListener("click", () => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    setPanelOpen(safeReadBoolean(panelStateKey, false));
  }

  function scheduleRefresh() {
    if (refreshTimer) return;

    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      applyAutomaticImprovements();
      updateCourt();
    }, 160);
  }

  function observeContentChanges() {
    if (!window.MutationObserver || !document.body) return;

    observer = new MutationObserver((mutations) => {
      const shouldRefresh = mutations.some((mutation) => {
        if (mutation.type !== "childList") return false;
        const target = mutation.target;
        if (target instanceof Element && target.closest(".gp-court-shell")) return false;
        return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
      });

      if (shouldRefresh) scheduleRefresh();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    applyAutomaticImprovements();
    mountWidget();
    updateCourt();
    observeContentChanges();
    window.addEventListener("load", scheduleRefresh, { once: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
