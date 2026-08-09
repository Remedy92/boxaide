const state = {
  token: localStorage.getItem("mailmux_token") || "",
  accounts: [],
  messages: [],
  selectedId: null,
  filter: "all",
};

const $ = (sel) => document.querySelector(sel);

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

async function api(path, opts = {}) {
  const headers = {
    ...(opts.headers || {}),
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (opts.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || res.statusText || "request failed");
  }
  return data;
}

function renderAccounts() {
  const list = $("#account-list");
  list.innerHTML = "";
  const filter = $("#account-filter");
  const composeSel = $("#compose-account");
  filter.innerHTML = `<option value="all">All accounts</option>`;
  composeSel.innerHTML = "";

  for (const a of state.accounts) {
    const li = document.createElement("li");
    li.innerHTML = `<div><div class="alias">${escapeHtml(a.alias)}</div><div class="email">${escapeHtml(a.email)}</div></div>`;
    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "Remove";
    del.onclick = async () => {
      if (!confirm(`Remove ${a.alias}?`)) return;
      await api(`/api/accounts/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      await loadAccounts();
      await loadMessages();
      toast("Account removed");
    };
    li.appendChild(del);
    list.appendChild(li);

    const opt = document.createElement("option");
    opt.value = a.alias;
    opt.textContent = `${a.alias} (${a.email})`;
    filter.appendChild(opt);

    const opt2 = opt.cloneNode(true);
    composeSel.appendChild(opt2);
  }
}

function renderMessages() {
  const ul = $("#message-list");
  const empty = $("#inbox-empty");
  ul.innerHTML = "";
  if (!state.messages.length) {
    empty.hidden = false;
    empty.textContent = state.accounts.length
      ? "No messages."
      : "Connect a mailbox to see your unified inbox.";
    return;
  }
  empty.hidden = true;
  for (const m of state.messages) {
    const li = document.createElement("li");
    if (!m.seen) li.classList.add("unread");
    if (m.id === state.selectedId) li.classList.add("active");
    const alias =
      state.accounts.find((a) => a.id === m.accountId)?.alias || m.accountId;
    li.innerHTML = `
      <div class="row1">
        <span class="from"><span class="badge">${escapeHtml(alias)}</span>${escapeHtml(m.from)}</span>
        <span class="date">${escapeHtml(formatDate(m.date))}</span>
      </div>
      <div class="subject">${escapeHtml(m.subject)}</div>
      <div class="snippet">${escapeHtml(m.snippet || "")}</div>
    `;
    li.onclick = () => openMessage(m);
    ul.appendChild(li);
  }
}

async function openMessage(m) {
  state.selectedId = m.id;
  renderMessages();
  const reader = $("#reader");
  reader.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const { message } = await api(
      `/api/messages/${encodeURIComponent(m.accountId)}/${encodeURIComponent(m.id)}`,
    );
    reader.innerHTML = `
      <h2>${escapeHtml(message.subject)}</h2>
      <div class="meta">
        <div><strong>From</strong> ${escapeHtml(message.from)}</div>
        <div><strong>To</strong> ${escapeHtml(message.to)}</div>
        <div><strong>Date</strong> ${escapeHtml(formatDate(message.date, true))}</div>
      </div>
      <div class="body">${escapeHtml(message.bodyText || "")}</div>
    `;
    reader.classList.add("show");
  } catch (err) {
    reader.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
}

async function loadAccounts() {
  const data = await api("/api/accounts");
  state.accounts = data.accounts || [];
  renderAccounts();
  updateMcpSnippet();
}

async function loadMessages() {
  const account = $("#account-filter").value || "all";
  const q = $("#search").value.trim();
  try {
    if (q) {
      const data = await api(
        `/api/messages/search?account=${encodeURIComponent(account)}&q=${encodeURIComponent(q)}`,
      );
      state.messages = data.messages || [];
    } else {
      const data = await api(
        `/api/messages?account=${encodeURIComponent(account)}&limit=50`,
      );
      state.messages = data.messages || [];
    }
    renderMessages();
  } catch (err) {
    toast(err.message);
  }
}

function updateMcpSnippet() {
  const token = state.token || "<token>";
  const snippet = {
    mcpServers: {
      mailmux: {
        url: `${location.origin}/mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  };
  $("#mcp-snippet").textContent = JSON.stringify(snippet, null, 2);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(iso, full = false) {
  try {
    const d = new Date(iso);
    if (full) return d.toLocaleString();
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

const PRESETS = {
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
  },
  fastmail: {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
  },
};

function wireUi() {
  $("#token-input").value = state.token;
  $("#btn-save-token").onclick = () => {
    state.token = $("#token-input").value.trim();
    localStorage.setItem("mailmux_token", state.token);
    updateMcpSnippet();
    toast("Token saved");
    boot();
  };

  $("#btn-show-connect").onclick = () => $("#connect-dialog").showModal();
  $("#btn-compose").onclick = () => {
    if (!state.accounts.length) {
      toast("Connect an account first");
      return;
    }
    $("#compose-dialog").showModal();
  };
  $("#btn-refresh").onclick = () => loadMessages();
  $("#account-filter").onchange = () => loadMessages();

  let searchTimer;
  $("#search").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadMessages, 250);
  };

  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.onclick = () => {
      const p = PRESETS[btn.dataset.preset];
      if (!p) return;
      const form = $("#connect-form");
      form.imapHost.value = p.imapHost;
      form.imapPort.value = p.imapPort;
      form.smtpHost.value = p.smtpHost;
      form.smtpPort.value = p.smtpPort;
    };
  });

  $("#connect-form").addEventListener("submit", async (e) => {
    // dialog form method=dialog closes; we intercept default button
  });

  $("#btn-connect").onclick = async (e) => {
    e.preventDefault();
    const form = $("#connect-form");
    const err = $("#connect-error");
    err.hidden = true;
    const body = {
      alias: form.alias.value.trim(),
      email: form.email.value.trim(),
      username: form.username.value.trim() || form.email.value.trim(),
      password: form.password.value,
      imapHost: form.imapHost.value.trim(),
      imapPort: Number(form.imapPort.value || 993),
      imapSecure: true,
      smtpHost: form.smtpHost.value.trim(),
      smtpPort: Number(form.smtpPort.value || 465),
      smtpSecure: Number(form.smtpPort.value || 465) === 465,
    };
    try {
      await api("/api/accounts", { method: "POST", body: JSON.stringify(body) });
      $("#connect-dialog").close();
      form.reset();
      await loadAccounts();
      await loadMessages();
      toast("Mailbox connected");
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };

  $("#btn-send").onclick = async (e) => {
    e.preventDefault();
    const form = $("#compose-form");
    const err = $("#compose-error");
    err.hidden = true;
    try {
      await api("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          account: form.account.value,
          to: form.to.value.trim(),
          subject: form.subject.value.trim(),
          text: form.text.value,
        }),
      });
      $("#compose-dialog").close();
      form.reset();
      toast("Sent");
      await loadMessages();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };

  $("#btn-copy-mcp").onclick = async () => {
    await navigator.clipboard.writeText($("#mcp-snippet").textContent);
    toast("Copied MCP config");
  };
}

async function boot() {
  if (!state.token) {
    try {
      const boot = await fetch("/api/local-bootstrap").then((r) => r.json());
      if (boot.token) {
        state.token = boot.token;
        localStorage.setItem("mailmux_token", state.token);
        $("#token-input").value = state.token;
      }
    } catch {
      /* ignore */
    }
  }
  if (!state.token) {
    updateMcpSnippet();
    $("#inbox-empty").textContent =
      "Paste the bearer token from the terminal (mailmux serve) into the sidebar, then Save token.";
    return;
  }
  try {
    await loadAccounts();
    await loadMessages();
  } catch (err) {
    $("#inbox-empty").textContent = err.message;
    toast(err.message);
  }
}

wireUi();
boot();
