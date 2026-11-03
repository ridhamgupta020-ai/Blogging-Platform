"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const planContainer = document.getElementById("membershipPlans");
  const feedback = document.getElementById("pricingFeedback");
  const navToggle = document.getElementById("navToggle");
  const navLinks = document.getElementById("navLinks");

  if (navToggle && navLinks) {
    const closeMenu = () => {
      navToggle.setAttribute("aria-expanded", "false");
      navToggle.setAttribute("aria-label", "Open navigation menu");
      navLinks.classList.remove("active");
    };

    navToggle.addEventListener("click", () => {
      const isOpen = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", String(!isOpen));
      navToggle.setAttribute("aria-label", isOpen ? "Open navigation menu" : "Close navigation menu");
      navLinks.classList.toggle("active", !isOpen);
    });

    navLinks.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMenu));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
    document.addEventListener("click", (event) => {
      if (!navLinks.contains(event.target) && !navToggle.contains(event.target)) closeMenu();
    });
  }

  const year = document.getElementById("currentYear");
  if (year) year.textContent = String(new Date().getFullYear());
  document.querySelector(".pricing-back-top")?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  if (!planContainer) return;

  const features = {
    free: [
      ["Basic blog publishing", true],
      ["Standard writing editor", true],
      ["Personal dashboard", true],
      ["Public blog access", true],
      ["Basic profile customization", true]
    ],
    premium: [
      ["Everything in Free", true],
      ["Unlimited blog publishing", false],
      ["Premium editor themes", false],
      ["AI writing assistance", false],
      ["Advanced analytics", false],
      ["Scheduled publishing", false],
      ["Premium creator badge", false],
      ["Ad-free experience", false]
    ],
    pro: [
      ["Everything in Premium", true],
      ["Advanced AI writing tools", false],
      ["SEO optimization assistant", false],
      ["Newsletter management", false],
      ["Custom blog themes", false],
      ["PDF export", false],
      ["Priority support", false]
    ],
    ultra_vip: [
      ["Everything in Pro", true],
      ["Highest AI usage limits", false],
      ["Custom domain connection", false],
      ["Team collaboration", false],
      ["Multiple author accounts", false],
      ["Premium portfolio", false],
      ["VIP support", false],
      ["Early access to new features", false]
    ]
  };
  const planIcons = { free: "✎", premium: "✦", pro: "↗", ultra_vip: "♛" };
  const planOrder = ["free", "premium", "pro", "ultra_vip"];
  const formatPrice = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);

  function showFeedback(message, type = "info") {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.dataset.type = type;
    feedback.hidden = false;
    feedback.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, { credentials: "include", ...options });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error || `Request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function featureMarkup(planSlug) {
    return (features[planSlug] || features.free).map(([label, available]) => `
      <li class="${available ? "" : "feature-planned"}">
        <span class="feature-check" aria-hidden="true">${available ? "✓" : "○"}</span>
        <span>${escapeHtml(label)}</span>
        ${available ? "" : '<span class="feature-status">Planned</span>'}
      </li>
    `).join("");
  }

  function renderPlans(plans, currentPlan) {
    planContainer.innerHTML = plans.map((plan) => {
      const slug = planOrder.includes(plan.slug) ? plan.slug : "free";
      const isCurrent = currentPlan === slug;
      const currentRank = planOrder.indexOf(currentPlan);
      const planRank = planOrder.indexOf(slug);
      const downgrade = currentRank > planRank;
      const classes = ["pricing-card", `${slug.replaceAll("_", "-")}-card`];
      if (slug === "premium") classes.push("premium-card");
      if (slug === "pro") classes.push("pro-card");
      if (slug === "ultra_vip") classes.push("vip-card");

      let actionLabel = "Upgrade to Premium";
      if (isCurrent) actionLabel = "Current Plan";
      else if (slug === "free") actionLabel = "Start Free";
      else if (slug === "pro") actionLabel = "Upgrade to Pro";
      else if (slug === "ultra_vip") actionLabel = "Upgrade to Ultra VIP";
      if (downgrade) actionLabel = "Available after expiry";

      const description = ({
        free: "Start publishing with a calm, focused set of creator essentials.",
        premium: "A more capable publishing workflow for growing creators.",
        pro: "A toolkit for creators ready to build a more strategic practice.",
        ultra_vip: "A premium foundation for ambitious creators and teams."
      })[slug];

      return `
        <article class="${classes.join(" ")}">
          ${slug === "premium" ? '<span class="pricing-popular">MOST POPULAR</span>' : ""}
          <div class="pricing-card-top">
            <span class="pricing-plan-icon" aria-hidden="true">${planIcons[slug] || "✎"}</span>
            ${isCurrent ? '<span class="pricing-current">Current plan</span>' : ""}
          </div>
          <h2>${escapeHtml(plan.name)}</h2>
          <div class="pricing-price">
            <strong>${formatPrice(plan.price_inr)}</strong>
            <span>/ year</span>
          </div>
          <p class="pricing-validity">${slug === "free" ? "Free forever" : "365 days of access"}</p>
          <p class="pricing-description">${escapeHtml(description)}</p>
          <ul class="pricing-feature-list">${featureMarkup(slug)}</ul>
          <button class="pricing-cta" type="button" data-plan="${escapeHtml(slug)}" ${isCurrent || downgrade ? "disabled" : ""}>
            ${escapeHtml(actionLabel)}
          </button>
        </article>
      `;
    }).join("");

    planContainer.querySelectorAll(".pricing-cta:not(:disabled)").forEach((button) => {
      button.addEventListener("click", () => startCheckout(button));
    });
    planContainer.setAttribute("aria-busy", "false");
  }

  async function startCheckout(button) {
    const plan = button.dataset.plan;
    if (plan === "free") {
      window.location.assign("/signup.html");
      return;
    }

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Preparing checkout…";
    if (feedback) feedback.hidden = true;

    try {
      const order = await fetchJson("/api/membership/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan })
      });

      if (order.mode === "demo" || order.provider !== "razorpay" || !order.key) {
        showFeedback("Online payments are not configured yet. No membership has been activated. Please try again later.", "error");
        return;
      }

      if (typeof window.Razorpay !== "function") {
        showFeedback("Secure checkout could not be loaded. Please check your connection and try again.", "error");
        return;
      }

      const checkout = new window.Razorpay({
        key: order.key,
        amount: Number(order.amount) * 100,
        currency: order.currency || "INR",
        name: "Draftly",
        description: `${order.plan?.name || "Draftly"} annual membership`,
        order_id: order.orderId,
        theme: { color: "#173B22" },
        handler: async (payment) => {
          try {
            await fetchJson("/api/membership/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                plan,
                orderId: payment.razorpay_order_id,
                paymentId: payment.razorpay_payment_id,
                signature: payment.razorpay_signature
              })
            });
            showFeedback("Payment verified. Your membership is now active.", "success");
            window.setTimeout(() => window.location.reload(), 900);
          } catch (error) {
            showFeedback(error.message || "Payment verification failed. Your membership has not been activated.", "error");
          } finally {
            button.disabled = false;
            button.textContent = originalText;
          }
        },
        modal: {
          ondismiss: () => {
            showFeedback("Checkout was cancelled. No payment or membership change was made.");
            button.disabled = false;
            button.textContent = originalText;
          }
        }
      });
      checkout.on("payment.failed", (event) => {
        showFeedback(event.error?.description || "Payment did not complete. Your membership has not changed.", "error");
        button.disabled = false;
        button.textContent = originalText;
      });
      checkout.open();
    } catch (error) {
      if (error.status === 401) {
        window.location.assign(`/login.html?next=${encodeURIComponent("/pricing.html")}`);
        return;
      }
      showFeedback(error.message || "Unable to start checkout. No membership has been activated.", "error");
    } finally {
      if (button.textContent === "Preparing checkout…") {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  }

  try {
    const plansPromise = fetchJson("/api/membership/plans");
    const authPromise = fetchJson("/api/auth/me").catch(() => ({ user: null }));
    const membershipPromise = authPromise.then(({ user }) => user
      ? fetch("/api/membership/me", { credentials: "include" })
        .then(async (response) => response.ok ? response.json() : null)
        .catch(() => null)
      : null);
    const [plansData, , membershipData] = await Promise.all([plansPromise, authPromise, membershipPromise]);
    const membership = membershipData?.membership;
    const currentPlan = membership?.status === "expired" ? "free" : membership?.plan || null;
    renderPlans(plansData.plans || [], currentPlan);
    if (membership?.status === "expired") {
      showFeedback("Your previous membership has expired. Renew or choose a plan to restore paid access.");
    }
  } catch (error) {
    console.error("Could not load Draftly membership plans:", error);
    planContainer.setAttribute("aria-busy", "false");
    planContainer.innerHTML = '<p class="pricing-loading" role="alert">Membership plans could not be loaded right now. Please refresh the page to try again.</p>';
  }
});
