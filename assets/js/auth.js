/* Greenew customer session and formatting helpers. */
(function () {
  "use strict";
  window.GreenewAuth = {
    requireAuth: async function () {
      if (window.GreenewReady) await window.GreenewReady;
      if (!window.sb) { location.href = "/index.html"; return null; }
      try {
        var { data: { session } } = await window.sb.auth.getSession();
        if (!session) { location.href = "/index.html"; return null; }
        var { data: profile } = await window.sb.from("profiles").select("is_active").eq("id", session.user.id).single();
        if (profile && profile.is_active === false) { await window.sb.auth.signOut(); location.href = "/banned.html"; return null; }
        return session;
      } catch (e) { location.href = "/index.html"; return null; }
    },
    requireAdmin: async function () {
      var session = await this.requireAuth();
      if (!session) return null;
      try {
        var { data } = await window.sb.from("profiles").select("is_admin").eq("id", session.user.id).single();
        if (!data?.is_admin) { location.href = "/dashboard.html"; return null; }
        return session;
      } catch (e) { location.href = "/dashboard.html"; return null; }
    },
    loadProfile: async function (userId) {
      if (window.GreenewReady) await window.GreenewReady;
      if (!window.sb) return null;
      try {
        var { data: profile } = await window.sb.from("profiles").select("*").eq("id", userId).single();
        if (!profile) return null;
        document.querySelectorAll("[data-auth]").forEach(function (el) {
          var key = el.dataset.auth;
          if (profile[key] !== undefined && profile[key] !== null) el.textContent = profile[key];
        });
        document.querySelectorAll("[data-vip]").forEach(function (el) {
          el.className = el.className.replace(/\bvip-\d\b/g, "");
          el.classList.add("vip-" + (profile.vip_level || 0));
          el.textContent = profile.vip_level > 0 ? "Tier " + profile.vip_level : "Customer";
        });
        return profile;
      } catch (e) { console.warn("Greenew profile load error", e); return null; }
    },
    logout: async function () {
      if (window.sb) { try { await window.sb.auth.signOut(); } catch (e) {} }
      location.href = "/index.html";
    },
    money: function (value) {
      return "₦" + Number(value || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },
    toast: function (message, duration) {
      var el = document.getElementById("toast");
      if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
      el.textContent = message; el.classList.add("show");
      clearTimeout(el._t); el._t = setTimeout(function () { el.classList.remove("show"); }, duration || 2600);
    },
    timeAgo: function (dateString) {
      var diff = Date.now() - new Date(dateString).getTime();
      var minutes = Math.floor(diff / 60000);
      if (minutes < 1) return "just now";
      if (minutes < 60) return minutes + "m ago";
      var hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + "h ago";
      return Math.floor(hours / 24) + "d ago";
    }
  };
})();
