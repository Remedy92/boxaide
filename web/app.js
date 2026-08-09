const state = {
  token: localStorage.getItem("mailmux_token") || "",
  accounts: [],
  messages: [],
  accountErrors: [],
  mailboxCount: 0,
  selectedId: null,
  openMessage: null,
  replyTo: null,
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

/* ---------- plain-language errors ---------- */

const ERROR_HINTS = [
  [
    /auth|invalid credential|login failed|password|AUTHENTICATIONFAILED|535|534/i,
    "Wrong username or app password. Gmail, iCloud and Outlook need an app password, not your normal password.",
  ],
  [
    /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|EHOSTUNREACH|ENETUNREACH|connection refused/i,
    "Cannot reach that IMAP server — check the host and port.",
  ],
  [
    /ETIMEDOUT|ESOCKETTIMEDOUT|timed out|timeout/i,
    "The mail server did not respond.",
  ],
  [
    /certificate|self[- ]signed|TLS|SSL/i,
    "The server refused the secure connection — check the port and whether TLS is required.",
  ],
];

function friendlyError(raw) {
  const msg = String(raw ?? "").trim();
  if (!msg) return "Something went wrong.";
  for (const [re, plain] of ERROR_HINTS) {
    if (re.test(msg)) return plain;
  }
  return msg;
}

/** Show a plain-language error, keeping the raw text available for debugging. */
function showError(el, raw) {
  const rawText = String(raw ?? "");
  const plain = friendlyError(rawText);
  el.textContent = "";
  el.title = rawText;
  const head = document.createElement("span");
  head.textContent = plain;
  el.appendChild(head);
  if (plain !== rawText) {
    const details = document.createElement("details");
    details.className = "raw";
    const summary = document.createElement("summary");
    summary.textContent = "Technical details";
    const pre = document.createElement("pre");
    pre.textContent = rawText;
    details.append(summary, pre);
    el.appendChild(details);
  }
  el.hidden = false;
}

function setPending(btn, pending, label) {
  if (!btn) return;
  if (pending) {
    if (btn.dataset.label === undefined) btn.dataset.label = btn.textContent;
    if (label) btn.textContent = label;
    btn.disabled = true;
    btn.classList.add("pending");
  } else {
    if (btn.dataset.label !== undefined) {
      btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
    }
    btn.disabled = false;
    btn.classList.remove("pending");
  }
}

/* ---------- rendering ---------- */

function aliasFor(accountRef) {
  const a = state.accounts.find(
    (x) => x.id === accountRef || x.alias === accountRef,
  );
  return a ? a.alias : String(accountRef ?? "unknown");
}

function renderAccounts() {
  const list = $("#account-list");
  list.innerHTML = "";
  const filter = $("#account-filter");
  const composeSel = $("#compose-account");
  const previous = filter.value;
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
  if (previous && [...filter.options].some((o) => o.value === previous)) {
    filter.value = previous;
  }
}

function renderBanner() {
  const el = $("#inbox-banner");
  const errors = state.accountErrors;
  if (!errors.length) {
    el.hidden = true;
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  const total = state.mailboxCount || errors.length;
  const loaded = Math.max(total - errors.length, 0);
  const detail = errors
    .map((e) => `${aliasFor(e.account)}: ${friendlyError(e.error)}`)
    .join("; ");
  el.textContent = `${loaded} of ${total} mailboxes loaded — ${detail}`;
  el.title = errors
    .map((e) => `${e.account}: ${e.error}`)
    .join("\n");
  el.hidden = false;
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

function readToggleLabel(seen) {
  return seen ? "Mark as unread" : "Mark as read";
}

async function setSeen(message, seen) {
  const btn = $("#btn-toggle-read");
  setPending(btn, true, "Saving…");
  try {
    await api(
      `/api/messages/${encodeURIComponent(message.accountId)}/${encodeURIComponent(message.id)}/read`,
      { method: "POST", body: JSON.stringify({ seen }) },
    );
    message.seen = seen;
    const listed = state.messages.find(
      (m) => m.id === message.id && m.accountId === message.accountId,
    );
    if (listed) listed.seen = seen;
    renderMessages();
    setPending(btn, false);
    if (btn) btn.textContent = readToggleLabel(seen);
  } catch (err) {
    setPending(btn, false);
    toast(friendlyError(err.message));
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
    state.openMessage = message;
    // Bodies are rendered as escaped text on purpose: never inject bodyHtml.
    reader.innerHTML = `
      <h2>${escapeHtml(message.subject)}</h2>
      <div class="meta">
        <div><strong>From</strong> ${escapeHtml(message.from)}</div>
        <div><strong>To</strong> ${escapeHtml(message.to)}</div>
        <div><strong>Date</strong> ${escapeHtml(formatDate(message.date, true))}</div>
      </div>
      <div class="reader-actions">
        <button type="button" id="btn-toggle-read" class="btn ghost">${escapeHtml(readToggleLabel(message.seen))}</button>
        <button type="button" id="btn-reply" class="btn ghost">Reply</button>
      </div>
      <div class="body">${escapeHtml(message.bodyText || "")}</div>
    `;
    reader.classList.add("show");
    $("#btn-toggle-read").onclick = () => setSeen(message, !message.seen);
    $("#btn-reply").onclick = () => openReply(message);
  } catch (err) {
    reader.innerHTML = "";
    const box = document.createElement("p");
    box.className = "error";
    reader.appendChild(box);
    showError(box, err.message);
  }
}

function openReply(message) {
  if (!state.accounts.length) {
    toast("Connect an account first");
    return;
  }
  const form = $("#compose-form");
  form.reset();
  const account = state.accounts.find((a) => a.id === message.accountId);
  if (account) form.account.value = account.alias;
  form.to.value = message.from || "";
  form.subject.value = /^re:/i.test(message.subject || "")
    ? message.subject
    : `Re: ${message.subject || ""}`;
  state.replyTo = message.messageId
    ? {
        inReplyTo: message.messageId,
        references: [message.references, message.messageId]
          .filter(Boolean)
          .join(" "),
      }
    : null;
  $("#compose-error").hidden = true;
  $("#compose-dialog").showModal();
}

/* ---------- loading ---------- */

async function loadAccounts() {
  const data = await api("/api/accounts");
  state.accounts = data.accounts || [];
  renderAccounts();
  updateMcpSnippet();
}

async function loadFolders() {
  const sel = $("#folder-filter");
  const account = $("#account-filter").value || "all";
  sel.innerHTML = `<option value="">Inbox</option>`;
  if (account === "all" || !state.accounts.length) {
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  try {
    const data = await api(
      `/api/folders?account=${encodeURIComponent(account)}`,
    );
    for (const f of data.folders || []) {
      const name = typeof f === "string" ? f : f.path || f.name;
      if (!name) continue;
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  } catch {
    /* folder listing is optional; Inbox still works */
  }
}

async function loadMessages() {
  const account = $("#account-filter").value || "all";
  const folder = $("#folder-filter").value || "";
  const q = $("#search").value.trim();
  state.mailboxCount = account === "all" ? state.accounts.length : 1;
  try {
    const base = q
      ? `/api/messages/search?account=${encodeURIComponent(account)}&q=${encodeURIComponent(q)}`
      : `/api/messages?account=${encodeURIComponent(account)}&limit=50`;
    const data = await api(
      folder ? `${base}&folder=${encodeURIComponent(folder)}` : base,
    );
    state.messages = data.messages || [];
    state.accountErrors = data.errors || [];
    renderBanner();
    renderMessages();
  } catch (err) {
    state.accountErrors = [];
    renderBanner();
    toast(friendlyError(err.message));
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
    hint: "Gmail needs a 16-character App password, not your Google password. Turn on 2-Step Verification first, then create one at myaccount.google.com/apppasswords.",
  },
  fastmail: {
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 465,
    hint: "Fastmail needs an app password: Settings → Privacy & Security → App passwords.",
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    hint: "Outlook needs an app password from account.microsoft.com → Security. Work or school accounts often block IMAP entirely.",
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    hint: "iCloud needs an app-specific password from account.apple.com → Sign-In and Security.",
  },
};

/* ---------- connect dialog ---------- */

function readConnectForm() {
  const form = $("#connect-form");
  const email = form.email.value.trim();
  const smtpPort = Number(form.smtpPort.value || 465);
  return {
    alias: form.alias.value.trim(),
    email,
    username: form.username.value.trim() || email,
    password: form.password.value,
    imapHost: form.imapHost.value.trim(),
    imapPort: Number(form.imapPort.value || 993),
    imapSecure: true,
    smtpHost: form.smtpHost.value.trim(),
    smtpPort,
    smtpSecure: smtpPort === 465,
  };
}

function connectBusy(busy, label) {
  setPending($("#btn-connect"), busy, label);
  setPending($("#btn-test"), busy, busy ? "Testing…" : undefined);
}

async function testConnection() {
  const form = $("#connect-form");
  const err = $("#connect-error");
  const ok = $("#connect-ok");
  err.hidden = true;
  ok.hidden = true;
  // A test only needs the credentials, not the alias.
  for (const field of ["email", "password", "imapHost", "smtpHost"]) {
    if (!form[field].value.trim()) {
      form[field].focus();
      showError(err, "Fill in email, password, IMAP host and SMTP host first.");
      return;
    }
  }
  const body = readConnectForm();
  connectBusy(true, "Testing connection…");
  try {
    const res = await api("/api/accounts/test", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (res.ok === false) {
      showError(err, res.error || "connection failed");
    } else {
      ok.textContent = "Connection works. You can save the mailbox now.";
      ok.hidden = false;
    }
  } catch (ex) {
    showError(err, ex.message);
  } finally {
    connectBusy(false);
  }
}

async function connectAccount() {
  const form = $("#connect-form");
  if (!form.reportValidity()) return;
  const err = $("#connect-error");
  const ok = $("#connect-ok");
  err.hidden = true;
  ok.hidden = true;
  connectBusy(true, "Testing connection…");
  try {
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify(readConnectForm()),
    });
    $("#connect-dialog").close();
    form.reset();
    $("#connect-hint").hidden = true;
    await loadAccounts();
    await loadFolders();
    await loadMessages();
    toast("Mailbox connected");
  } catch (ex) {
    showError(err, ex.message);
  } finally {
    connectBusy(false);
  }
}

/* ---------- wiring ---------- */

function wireUi() {
  $("#token-input").value = state.token;
  $("#btn-save-token").onclick = () => {
    state.token = $("#token-input").value.trim();
    localStorage.setItem("mailmux_token", state.token);
    updateMcpSnippet();
    toast("Token saved");
    boot();
  };

  $("#btn-show-connect").onclick = () => {
    $("#connect-error").hidden = true;
    $("#connect-ok").hidden = true;
    $("#connect-dialog").showModal();
  };
  $("#btn-compose").onclick = () => {
    if (!state.accounts.length) {
      toast("Connect an account first");
      return;
    }
    state.replyTo = null;
    $("#compose-error").hidden = true;
    $("#compose-dialog").showModal();
  };
  $("#btn-refresh").onclick = () => loadMessages();
  $("#account-filter").onchange = async () => {
    await loadFolders();
    await loadMessages();
  };
  $("#folder-filter").onchange = () => loadMessages();

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
      const hint = $("#connect-hint");
      hint.textContent = p.hint;
      hint.hidden = false;
    };
  });

  // Enter anywhere in the dialog submits the form, same path as the button.
  $("#connect-form").addEventListener("submit", (e) => {
    e.preventDefault();
    connectAccount();
  });
  $("#btn-test").onclick = () => testConnection();
  $("#connect-cancel").onclick = () => $("#connect-dialog").close();

  $("#compose-form").addEventListener("submit", (e) => {
    e.preventDefault();
    sendMessage();
  });
  $("#compose-cancel").onclick = () => $("#compose-dialog").close();

  $("#btn-copy-mcp").onclick = async () => {
    await navigator.clipboard.writeText($("#mcp-snippet").textContent);
    toast("Copied MCP config");
  };
}

async function sendMessage() {
  const form = $("#compose-form");
  if (!form.reportValidity()) return;
  const err = $("#compose-error");
  err.hidden = true;
  const btn = $("#btn-send");
  setPending(btn, true, "Sending…");
  try {
    await api("/api/messages/send", {
      method: "POST",
      body: JSON.stringify({
        account: form.account.value,
        to: form.to.value.trim(),
        subject: form.subject.value.trim(),
        text: form.text.value,
        ...(state.replyTo || {}),
      }),
    });
    $("#compose-dialog").close();
    form.reset();
    state.replyTo = null;
    toast("Sent");
    await loadMessages();
  } catch (ex) {
    showError(err, ex.message);
  } finally {
    setPending(btn, false);
  }
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
    await loadFolders();
    await loadMessages();
  } catch (err) {
    $("#inbox-empty").textContent = friendlyError(err.message);
    toast(friendlyError(err.message));
  }
}

wireUi();
boot();
