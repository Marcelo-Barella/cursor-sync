(function () {
  const vscode = acquireVsCodeApi();

  function post(command, extra) {
    vscode.postMessage(Object.assign({ command: command }, extra || {}));
  }

  function onSettingChange(key, value) {
    post("settings:set", { key: key, value: value });
  }

  function switchTab(tabId) {
    document.querySelectorAll(".tab-pane").forEach(function (p) {
      p.style.display = "none";
    });
    document.querySelectorAll(".tab-btn").forEach(function (b) {
      b.classList.remove("active");
    });
    var pane = document.getElementById(tabId);
    if (pane) pane.style.display = "";
    document
      .querySelectorAll('.tab-btn[data-tab="' + tabId + '"]')
      .forEach(function (b) {
        b.classList.add("active");
      });
    if (tabId === "chats-pane") {
      post("chats:listLocal");
      post("chats:listImports");
      post("chats:listBundles");
    } else if (tabId === "settings-pane") {
      post("settings:get");
    }
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relTime(iso) {
    var diffMs = Date.now() - new Date(iso).getTime();
    if (diffMs < 0) return "just now";
    var s = Math.floor(diffMs / 1000);
    if (s < 60) return "just now";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    var d = Math.floor(h / 24);
    if (d < 30) return d + "d ago";
    return new Date(iso).toLocaleDateString();
  }

  function fmtBytes(b) {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return Math.round(b / 1024) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
  }

  function applyTheme(effective, preference) {
    if (effective === "light" || effective === "dark") {
      document.documentElement.setAttribute("data-theme", effective);
    }
    document.querySelectorAll(".theme-segment").forEach(function (btn) {
      var pref = btn.getAttribute("data-theme-preference");
      var active = pref === preference;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  document.addEventListener("click", function (ev) {
    var t = ev.target;
    var el = t && t.nodeType === 1 ? t : t && t.parentElement;
    var themeBtn = el && el.closest ? el.closest(".theme-segment[data-theme-preference]") : null;
    if (themeBtn) {
      var pref = themeBtn.getAttribute("data-theme-preference");
      if (pref) {
        post("settings:set", { key: "appearance.theme", value: pref });
      }
      return;
    }
    var tabBtn = el && el.closest ? el.closest(".tab-btn[data-tab]") : null;
    if (tabBtn) {
      switchTab(tabBtn.getAttribute("data-tab"));
      return;
    }
    var cmdBtn = el && el.closest ? el.closest("[data-command]") : null;
    if (!cmdBtn) return;
    var cmd = cmdBtn.getAttribute("data-command");
    if (!cmd) return;
    var extra = {};
    var conversationId = cmdBtn.getAttribute("data-conversation-id");
    if (conversationId) extra.conversationId = conversationId;
    var bundlePath = cmdBtn.getAttribute("data-bundle-path");
    if (bundlePath) extra.bundlePath = bundlePath;
    post(cmd, extra);
  });

  document.addEventListener("change", function (ev) {
    var el = ev.target;
    if (!el || !el.getAttribute) return;
    var key = el.getAttribute("data-setting-key");
    if (!key) return;
    var value =
      el.type === "checkbox"
        ? el.checked
        : el.type === "number"
          ? Number(el.value)
          : el.value;
    onSettingChange(key, value);
  });

  window.addEventListener("message", function (ev) {
    var msg = ev.data;
    if (!msg || !msg.type) return;

    if (msg.type === "sync:update") {
      var syncPane = document.getElementById("sync-pane");
      if (syncPane && msg.html) {
        var activeBtn = document.querySelector(".tab-btn.active");
        var activeTab = activeBtn ? activeBtn.getAttribute("data-tab") : "sync-pane";
        syncPane.outerHTML = msg.html;
        if (activeTab !== "sync-pane") {
          var newSync = document.getElementById("sync-pane");
          if (newSync) newSync.style.display = "none";
        }
      }
      return;
    }

    if (msg.type === "chats:recent") {
      var el = document.getElementById("chats-recent");
      if (!el) return;
      if (!msg.rows || msg.rows.length === 0) {
        el.innerHTML = '<div class="empty-state">No chats in this workspace</div>';
        return;
      }
      el.innerHTML = msg.rows
        .map(function (r) {
          return (
            '<div class="chat-row">' +
            '<div class="chat-row-info">' +
            '<div class="chat-row-title">' +
            escHtml(r.label || r.conversationId) +
            "</div>" +
            '<div class="chat-row-meta">' +
            escHtml(r.detail || "") +
            "</div>" +
            "</div>" +
            '<div class="chat-row-actions">' +
            '<button class="chat-action-btn" data-command="chats:reactivate" data-conversation-id="' +
            escHtml(r.conversationId) +
            '">Open</button>' +
            '<button class="chat-action-btn" data-command="chats:revealTranscripts" data-conversation-id="' +
            escHtml(r.conversationId) +
            '">Files</button>' +
            "</div>" +
            "</div>"
          );
        })
        .join("");
    }

    if (msg.type === "chats:imports") {
      var el2 = document.getElementById("chats-imports");
      if (!el2) return;
      if (!msg.rows || msg.rows.length === 0) {
        el2.innerHTML = '<div class="empty-state">No import history</div>';
        return;
      }
      el2.innerHTML = msg.rows
        .map(function (r) {
          var warnings =
            r.warnings > 0 ? " \u00b7 " + r.warnings + " warn" : "";
          var fidelity =
            typeof r.schemaVersion === "number"
              ? " \u00b7 v" + r.schemaVersion
              : "";
          var tools =
            typeof r.toolBubbleCount === "number"
              ? " \u00b7 " + r.toolBubbleCount + " tool bubbles"
              : "";
          var layer4 = r.textOnlyLayer4
            ? ' <span class="fidelity-warn">text-only L4</span>'
            : "";
          return (
            '<div class="chat-row">' +
            '<div class="chat-row-info">' +
            '<div class="chat-row-title">' +
            escHtml(r.conversationId) +
            "</div>" +
            '<div class="chat-row-meta">' +
            relTime(r.timestamp) +
            " \u00b7 " +
            r.transcriptsWritten +
            " transcripts" +
            fidelity +
            tools +
            layer4 +
            warnings +
            "</div>" +
            "</div>" +
            "</div>"
          );
        })
        .join("");
    }

    if (msg.type === "chats:bundles") {
      var el3 = document.getElementById("chats-bundles");
      if (!el3) return;
      if (!msg.entries || msg.entries.length === 0) {
        el3.innerHTML = '<div class="empty-state">No bundle files found</div>';
        return;
      }
      el3.innerHTML = msg.entries
        .map(function (e) {
          var name = e.bundlePath.split("/").pop() || e.bundlePath;
          return (
            '<div class="chat-row">' +
            '<div class="chat-row-info">' +
            '<div class="chat-row-title">' +
            escHtml(name) +
            "</div>" +
            '<div class="chat-row-meta">' +
            fmtBytes(e.bytes) +
            " \u00b7 " +
            relTime(e.modifiedAt) +
            " \u00b7 " +
            e.source +
            "</div>" +
            "</div>" +
            '<div class="chat-row-actions">' +
            '<button class="chat-action-btn" data-command="chats:importBundle" data-bundle-path="' +
            escHtml(e.bundlePath) +
            '">Import</button>' +
            "</div>" +
            "</div>"
          );
        })
        .join("");
    }

    if (msg.type === "chats:progress") {
      var section = document.getElementById("chats-active-section");
      var el4 = document.getElementById("chats-active");
      if (!section || !el4) return;
      var ev2 = msg.event;
      if (ev2.done) {
        section.style.display = "none";
        el4.innerHTML = "";
      } else {
        section.style.display = "";
        var pct = typeof ev2.increment === "number" ? ev2.increment : 0;
        var stepLabel = ev2.step || ev2.message || "";
        var detail = ev2.detail || "";
        if (ev2.fidelity && ev2.fidelity.textOnlyLayer4) {
          detail =
            detail ||
            "text-only Layer 4 (no diskKvSnapshot); tool/MCP UI may not match source";
        }
        var warnClass =
          ev2.fidelity && ev2.fidelity.textOnlyLayer4 ? " fidelity-warn" : "";
        el4.innerHTML =
          '<div class="progress-card' +
          warnClass +
          '">' +
          '<div class="progress-phase">' +
          escHtml("Phase " + (ev2.phase || "") + (stepLabel ? " · " + stepLabel : "")) +
          "</div>" +
          '<div class="progress-message">' +
          escHtml(detail) +
          "</div>" +
          (pct > 0
            ? '<div class="progress-bar-track"><div class="progress-bar-fill" style="width:' +
              Math.min(100, pct) +
              '%"></div></div>'
            : "") +
          "</div>";
      }
    }

    if (msg.type === "chats:history-cleared") {
      var el5 = document.getElementById("chats-imports");
      if (el5) el5.innerHTML = '<div class="empty-state">No import history</div>';
    }

    if (msg.type === "theme:apply") {
      applyTheme(msg.effective, msg.preference);
      return;
    }

    if (msg.type === "settings:current") {
      var vals = msg.values;
      if (!vals) return;
      if (vals.appearanceTheme) {
        document.querySelectorAll(".theme-segment").forEach(function (btn) {
          var pref = btn.getAttribute("data-theme-preference");
          var active = pref === vals.appearanceTheme;
          btn.classList.toggle("active", active);
          btn.setAttribute("aria-pressed", active ? "true" : "false");
        });
      }
      Object.keys(vals).forEach(function (k) {
        var settingsKey =
          k === "appearanceTheme"
            ? null
            : k === "activateDefault"
            ? "chatImport.activateDefault"
            : k === "activateStrict"
              ? "chatImport.activateStrict"
              : k === "bridgeWaitResultSeconds"
                ? "chatImport.bridgeWaitResultSeconds"
                : k === "autoReloadAfterImport"
                  ? "transcripts.autoReloadAfterImport"
                  : k === "pythonPath"
                    ? "chatImport.pythonPath"
                    : null;
        if (!settingsKey) return;
        var el6 = document.getElementById(settingsKey);
        if (!el6) return;
        if (el6.type === "checkbox") el6.checked = Boolean(vals[k]);
        else el6.value = vals[k];
      });
    }
  });
})();
