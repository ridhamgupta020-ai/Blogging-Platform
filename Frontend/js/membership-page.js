document.addEventListener("DOMContentLoaded", async () => {
  const planContainer = document.getElementById("membershipPlans");
  const navToggle = document.getElementById("navToggle");
  const navLinks = document.getElementById("navLinks");

  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => {
      const open = navToggle.getAttribute("aria-expanded") === "true";
      navToggle.setAttribute("aria-expanded", String(!open));
      navLinks.classList.toggle("active");
    });
  }

  if (!planContainer) return;

  try {
    const [plansResponse, meResponse] = await Promise.all([
      fetch("/api/membership/plans", { credentials: "include" }),
      fetch("/api/membership/me", { credentials: "include" })
    ]);

    if (!plansResponse.ok) throw new Error("Unable to load membership plans.");
    const plansData = await plansResponse.json();
    const meData = meResponse.ok ? await meResponse.json() : { membership: { plan: "free" } };
    const currentPlan = meData.membership?.plan || "free";

    const defaultFeatures = {
      free: ["Basic blog publishing", "Standard writing editor", "Personal dashboard", "Read and explore public blogs"],
      premium: ["Everything in Free", "Unlimited blog publishing", "Premium editor themes", "Advanced analytics", "Scheduled publishing"],
      pro: ["Everything in Premium", "AI title suggestions", "SEO assistant", "Newsletter tools", "PDF export"],
      ultra_vip: ["Everything in Pro", "Custom domain", "Team workspace", "Multiple author accounts", "VIP support"]
    };

    planContainer.innerHTML = (plansData.plans || []).map((plan) => {
      const isCurrent = plan.slug === currentPlan;
      const isRecommended = plan.recommended;
      const planFeatures = defaultFeatures[plan.slug] || defaultFeatures.free;
      return `
        <article class="plan-card ${isRecommended ? "featured-plan" : ""} ${isCurrent ? "current-plan" : ""}">
          <div class="plan-top-row">
            <span class="plan-label">${plan.name.toUpperCase()}</span>
            ${isRecommended ? '<span class="plan-badge">Recommended</span>' : ""}
            ${isCurrent ? '<span class="plan-status">Current</span>' : ""}
          </div>
          <h3>${plan.name}</h3>
          <div class="plan-price-wrap">
            <span class="price">₹${plan.price_inr}</span>
            <span class="price-suffix">/year</span>
          </div>
          <p class="plan-subtext">Billed yearly — 365 days of access</p>
          <p class="plan-description">${plan.description || "Annual access to Draftly's premium publishing toolkit."}</p>
          <ul>
            ${planFeatures.map((feature) => `<li>${feature}</li>`).join("")}
          </ul>
          <button type="button" class="plan-cta" data-plan="${plan.slug}" ${isCurrent ? "disabled" : ""}>
            ${isCurrent ? "Current plan" : plan.slug === "free" ? "Start free" : "Upgrade"}
          </button>
        </article>
      `;
    }).join("");

    planContainer.querySelectorAll(".plan-cta").forEach((button) => {
      button.addEventListener("click", async () => {
        const plan = button.dataset.plan;
        try {
          const response = await fetch("/api/membership/checkout", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ plan })
          });

          const data = await response.json();
          if (!response.ok) {
            throw new Error(data.error || "Unable to start checkout.");
          }

          if (data.provider === "demo") {
            const verified = await fetch("/api/membership/verify", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ plan, orderId: data.orderId, paymentId: `demo_${Date.now()}`, amount: data.amount, signature: `demo_${Date.now()}` })
            });
            const verifiedPayload = await verified.json();
            if (!verified.ok || !verifiedPayload.success) {
              throw new Error("The demo checkout could not be verified.");
            }
            window.location.reload();
            return;
          }

          window.location.href = `/login.html?next=${encodeURIComponent("/pricing.html")}`;
        } catch (error) {
          console.error(error);
          alert(error.message || "Unable to continue with membership checkout.");
        }
      });
    });
  } catch (error) {
    console.error(error);
    planContainer.innerHTML = `<p class="app-notice error">Membership plans could not be loaded right now.</p>`;
  }
});
