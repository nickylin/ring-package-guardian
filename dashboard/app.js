/* Ring Package Guardian — 实时看板
 *
 * 依赖表结构：
 *   ring_events(id, ring_event_id, event_type, device_id, sub_type, occurred_at,
 *               snapshot_path, ai_label, ai_confidence, raw, created_at)
 *   ring_alerts(id, type, message, event_id, created_at)   — type: package_arrived |
 *               package_removed | night_activity；表不存在时告警区自动隐藏
 *
 * 快照签名 URL：POST <SUPABASE_URL>/functions/v1/snapshot-url  body {path}
 *   返回 {url: signedUrl}
 */

(function () {
  "use strict";

  // ---------- 配置 ----------
  var params = new URLSearchParams(location.search);
  var SUPABASE_URL = params.get("supabase_url") || CONFIG.SUPABASE_URL;
  var SUPABASE_ANON_KEY = params.get("anon_key") || CONFIG.SUPABASE_ANON_KEY;

  // ---------- 常量 ----------
  var EVENT_TYPE_CN = {
    motion_detected: "移动侦测",
    button_press: "门铃按下",
  };
  var AI_LABEL_CN = {
    person: "有人",
    package: "包裹",
    pet: "宠物",
    vehicle: "车辆",
    none: "无目标",
  };
  var ALERT_TEXT = {
    package_arrived: "📦 包裹送达",
    package_removed: "⚠️ 包裹可能被取走",
    night_activity: "🌙 夜间活动",
  };
  var timeFmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // ---------- DOM ----------
  var statusDot = document.getElementById("statusDot");
  var statusText = document.getElementById("statusText");
  var alertBanner = document.getElementById("alertBanner");
  var alertList = document.getElementById("alertList");
  var timeline = document.getElementById("timeline");
  var filterButtons = document.querySelectorAll(".filter button");

  var state = {
    events: [],       // 全部事件（内存缓存，筛选时用）
    filter: "all",
    signedUrlCache: {}, // snapshot_path -> {url, exp}
    alertsTableOk: true,
    bannerTimer: null,
  };

  function setStatus(online, text) {
    statusDot.className = "brand-dot " + (online ? "online" : "offline");
    statusText.textContent = text;
  }

  function fmtTime(iso) {
    try {
      return timeFmt.format(new Date(iso));
    } catch (e) {
      return iso || "";
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- Supabase ----------
  var supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  async function signedUrl(path) {
    if (!path) return null;
    var cached = state.signedUrlCache[path];
    if (cached && cached.exp > Date.now() + 60000) return cached.url;
    try {
      var res = await fetch(SUPABASE_URL + "/functions/v1/snapshot-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          Authorization: "Bearer " + SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ path: path }),
      });
      if (!res.ok) return null;
      var data = await res.json();
      if (data && data.url) {
        state.signedUrlCache[path] = { url: data.url, exp: Date.now() + 55 * 60000 };
        return data.url;
      }
    } catch (e) {
      /* 忽略，显示占位 */
    }
    return null;
  }

  // ---------- 渲染 ----------
  function aiBadge(label, confidence) {
    if (!label) return '<span class="badge">AI 分析中…</span>';
    var cn = AI_LABEL_CN[label] || label;
    var conf =
      confidence != null ? " " + Math.round(Number(confidence) * 100) + "%" : "";
    var low = confidence != null && Number(confidence) < 0.5 ? " low" : "";
    return (
      '<span class="badge ' + esc(label) + low + '">' + esc(cn) + esc(conf) + "</span>"
    );
  }

  async function eventCard(ev, isNew) {
    var el = document.createElement("div");
    el.className = "event-card" + (isNew ? " new" : "");
    el.dataset.eventId = ev.id;
    el.dataset.aiLabel = ev.ai_label || "";

    var media;
    if (ev.snapshot_path) {
      var url = await signedUrl(ev.snapshot_path);
      media = url
        ? '<img class="thumb" loading="lazy" src="' + esc(url) + '" alt="快照" />'
        : '<div class="thumb-placeholder">快照加载失败</div>';
    } else {
      media = '<div class="thumb-placeholder">无快照</div>';
    }

    el.innerHTML =
      media +
      '<div class="event-body">' +
      '<div class="event-head">' +
      '<span class="event-type">' +
      esc(EVENT_TYPE_CN[ev.event_type] || ev.event_type) +
      "</span>" +
      '<span class="event-time">' + esc(fmtTime(ev.occurred_at)) + "</span>" +
      "</div>" +
      '<div class="badges">' +
      aiBadge(ev.ai_label, ev.ai_confidence) +
      "</div>" +
      "</div>";
    return el;
  }

  function passesFilter(ev) {
    if (state.filter === "all") return true;
    return (ev.ai_label || "") === state.filter;
  }

  async function renderTimeline() {
    timeline.innerHTML = "";
    var shown = state.events.filter(passesFilter);
    if (!shown.length) {
      timeline.innerHTML = '<p class="empty">暂无事件</p>';
      return;
    }
    for (var i = 0; i < shown.length; i++) {
      timeline.appendChild(await eventCard(shown[i], false));
    }
  }

  function renderAlerts(alerts) {
    alertList.innerHTML = "";
    if (!alerts.length) {
      alertList.innerHTML = '<p class="empty">暂无告警</p>';
      return;
    }
    alerts.forEach(function (a) {
      var el = document.createElement("div");
      el.className = "alert-item";
      el.innerHTML =
        "<span>" + esc(ALERT_TEXT[a.type] || a.type) +
        (a.message ? " · " + esc(a.message) : "") +
        '</span><span class="time">' + esc(fmtTime(a.created_at)) + "</span>";
      alertList.appendChild(el);
    });
  }

  function showBanner(alert) {
    var text = (ALERT_TEXT[alert.type] || alert.type) +
      (alert.message ? " · " + alert.message : "");
    alertBanner.textContent = text;
    alertBanner.className = "alert-banner " + alert.type;
    if (state.bannerTimer) clearTimeout(state.bannerTimer);
    state.bannerTimer = setTimeout(function () {
      alertBanner.className = "alert-banner hidden";
    }, 8000);
  }

  // ---------- 数据加载 ----------
  async function loadEvents() {
    var res = await supabase
      .from("ring_events")
      .select("*")
      .order("occurred_at", { ascending: false })
      .limit(100);
    if (res.error) throw res.error;
    state.events = res.data || [];
    await renderTimeline();
  }

  async function loadAlerts() {
    if (!state.alertsTableOk) return;
    var res = await supabase
      .from("ring_alerts")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10);
    if (res.error) {
      // 表尚未创建时静默降级
      state.alertsTableOk = false;
      return;
    }
    renderAlerts(res.data || []);
  }

  // ---------- Realtime ----------
  function subscribe() {
    var channel = supabase
      .channel("guardian-live")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ring_events" },
        async function (payload) {
          var ev = payload.new;
          state.events.unshift(ev);
          state.events = state.events.slice(0, 100);
          if (passesFilter(ev)) {
            var empty = timeline.querySelector(".empty");
            if (empty) empty.remove();
            var card = await eventCard(ev, true);
            timeline.prepend(card);
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "ring_alerts" },
        function (payload) {
          if (!state.alertsTableOk) return;
          var a = payload.new;
          var empty = alertList.querySelector(".empty");
          if (empty) empty.remove();
          var el = document.createElement("div");
          el.className = "alert-item";
          el.innerHTML =
            "<span>" + esc(ALERT_TEXT[a.type] || a.type) +
            (a.message ? " · " + esc(a.message) : "") +
            '</span><span class="time">' + esc(fmtTime(a.created_at)) + "</span>";
          alertList.prepend(el);
          showBanner(a);
        }
      )
      .subscribe(function (status) {
        if (status === "SUBSCRIBED") {
          setStatus(true, "实时连接正常");
        } else if (status === "CLOSED" || status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
          setStatus(false, "连接中断，重试中…");
        }
      });
    return channel;
  }

  // ---------- 筛选 ----------
  filterButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      filterButtons.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.filter = btn.dataset.filter;
      renderTimeline();
    });
  });

  // ---------- 启动 ----------
  (async function init() {
    if (!SUPABASE_URL || SUPABASE_URL.indexOf("__SUPABASE") === 0) {
      setStatus(false, "未配置 Supabase（替换 CONFIG 或加 query 参数）");
      return;
    }
    try {
      await loadEvents();
      await loadAlerts();
      subscribe();
      setStatus(true, "已连接");
    } catch (e) {
      setStatus(false, "加载失败：" + (e.message || e));
    }
  })();
})();
