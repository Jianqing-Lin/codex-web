"use strict";

const STORAGE_KEY = "codex-web-state-v1";
const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_TOTAL_BYTES = 30 * 1024 * 1024;
const QUICK_PROMPTS = [
  { label: "修复", text: "请检查当前问题，定位原因并直接修复。" },
  { label: "审查", text: "请从代码审查角度检查最近改动，优先指出 bug、风险和缺失测试。" },
  { label: "测试", text: "请为当前改动补充或更新必要测试，并运行可用校验。" },
  { label: "解释", text: "请解释这段代码的行为、关键路径和可能的边界情况。" }
];

const state = {
  ws: null,
  ready: false,
  running: false,
  ptyAvailable: false,
  reconnectTimer: null,
  currentCwd: "/root",
  treePath: "/root",
  treeParent: null,
  currentFile: null,
  currentFileName: "",
  lastSavedContent: "",
  fileDirty: false,
  historySessions: [],
  currentHistoryId: null,
  currentHistorySession: null,
  currentHistoryMessages: [],
  historyHydratedId: null,
  viewMode: "chat",
  uploading: false,
  attachments: [],
  recentUploads: [],
  historyFilter: "",
  skills: [],
  plugins: [],
  catalogMode: "skills",
  catalogFilter: "",
  catalogSelected: null,
  selectedTools: [],
  sessionTitle: "新对话",
  activeChatOutput: null,
  activeChatOutputKind: "",
  pendingInput: null,
  intentionalClose: false
};

const dom = {
  activeCwd: document.getElementById("activeCwd"),
  attachmentTray: document.getElementById("attachmentTray"),
  attachFileBtn: document.getElementById("attachFileBtn"),
  argsInput: document.getElementById("argsInput"),
  autoScrollToggle: document.getElementById("autoScrollToggle"),
  chatStream: document.getElementById("chatStream"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  catalogDetail: document.getElementById("catalogDetail"),
  catalogList: document.getElementById("catalogList"),
  catalogPluginsTab: document.getElementById("catalogPluginsTab"),
  catalogSearchInput: document.getElementById("catalogSearchInput"),
  catalogSection: document.getElementById("catalogSection"),
  catalogSkillsTab: document.getElementById("catalogSkillsTab"),
  catalogTitle: document.getElementById("catalogTitle"),
  composerQuickActions: document.getElementById("composerQuickActions"),
  copyLogBtn: document.getElementById("copyLogBtn"),
  cwdInput: document.getElementById("cwdInput"),
  editorTitle: document.getElementById("editorTitle"),
  fileEditor: document.getElementById("fileEditor"),
  fileMeta: document.getElementById("fileMeta"),
  filePathInput: document.getElementById("filePathInput"),
  fileTree: document.getElementById("fileTree"),
  historyList: document.getElementById("historyList"),
  historySearchInput: document.getElementById("historySearchInput"),
  historyViewer: document.getElementById("historyViewer"),
  lastEvent: document.getElementById("lastEvent"),
  processStatus: document.getElementById("processStatus"),
  projectList: document.getElementById("projectList"),
  promptForm: document.getElementById("promptForm"),
  promptInput: document.getElementById("promptInput"),
  ptyStatus: document.getElementById("ptyStatus"),
  ptyToggle: document.getElementById("ptyToggle"),
  newFileBtn: document.getElementById("newFileBtn"),
  pluginsNavBtn: document.getElementById("pluginsNavBtn"),
  refreshProjectsBtn: document.getElementById("refreshProjectsBtn"),
  refreshCatalogBtn: document.getElementById("refreshCatalogBtn"),
  refreshHistoryBtn: document.getElementById("refreshHistoryBtn"),
  refreshTreeBtn: document.getElementById("refreshTreeBtn"),
  recentUploadList: document.getElementById("recentUploadList"),
  reloadFileBtn: document.getElementById("reloadFileBtn"),
  saveFileBtn: document.getElementById("saveFileBtn"),
  sendEnterBtn: document.getElementById("sendEnterBtn"),
  sendInterruptBtn: document.getElementById("sendInterruptBtn"),
  sendPromptBtn: document.getElementById("sendPromptBtn"),
  sendRawBtn: document.getElementById("sendRawBtn"),
  showChatBtn: document.getElementById("showChatBtn"),
  showTerminalBtn: document.getElementById("showTerminalBtn"),
  searchNavBtn: document.getElementById("searchNavBtn"),
  skillsNavBtn: document.getElementById("skillsNavBtn"),
  socketStatus: document.getElementById("socketStatus"),
  sourceList: document.getElementById("sourceList"),
  startBtn: document.getElementById("startBtn"),
  stageTitleText: document.getElementById("stageTitleText"),
  stopBtn: document.getElementById("stopBtn"),
  terminal: document.getElementById("terminal"),
  toolTray: document.getElementById("toolTray"),
  treePathInput: document.getElementById("treePathInput"),
  upDirBtn: document.getElementById("upDirBtn"),
  uploadComposerBtn: document.getElementById("uploadComposerBtn"),
  uploadFilesBtn: document.getElementById("uploadFilesBtn"),
  uploadInput: document.getElementById("uploadInput"),
  sessionNotes: document.getElementById("sessionNotes")
};

function loadStoredState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (typeof stored.cwd === "string" && stored.cwd) {
      state.currentCwd = stored.cwd;
      state.treePath = stored.cwd;
    }
    if (typeof stored.args === "string") {
      dom.argsInput.value = stored.args;
    }
    if (typeof stored.notes === "string") {
      dom.sessionNotes.value = stored.notes;
    }
    if (typeof stored.pty === "boolean") {
      dom.ptyToggle.checked = stored.pty;
    }
    if (typeof stored.autoScroll === "boolean") {
      dom.autoScrollToggle.checked = stored.autoScroll;
    }
  } catch (_err) {
    localStorage.removeItem(STORAGE_KEY);
  }

  dom.cwdInput.value = state.currentCwd;
  dom.treePathInput.value = state.treePath;
  dom.activeCwd.textContent = state.currentCwd;
}

function saveStoredState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    cwd: dom.cwdInput.value.trim() || "/root",
    args: dom.argsInput.value,
    notes: dom.sessionNotes.value,
    pty: dom.ptyToggle.checked,
    autoScroll: dom.autoScrollToggle.checked
  }));
}

function fallbackErrorMessage(status, statusText) {
  return `请求失败：${status}${statusText ? ` ${statusText}` : ""}`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || fallbackErrorMessage(response.status, response.statusText));
  }
  return data;
}

function setLastEvent(message) {
  dom.lastEvent.textContent = message;
}

function setSocketStatus(kind, text) {
  dom.socketStatus.className = `status-pill ${kind}`;
  dom.socketStatus.textContent = text;
}

function setProcessStatus(kind, text) {
  dom.processStatus.className = `status-pill ${kind}`;
  dom.processStatus.textContent = text;
}

function updateControls() {
  dom.startBtn.disabled = !state.ready || state.running;
  dom.stopBtn.disabled = !state.running;
  dom.sendPromptBtn.disabled = !state.ready;
  dom.sendRawBtn.disabled = !state.ready;
  dom.sendEnterBtn.disabled = !state.running;
  dom.sendInterruptBtn.disabled = !state.running;
  dom.showChatBtn.disabled = state.viewMode === "chat";
  dom.showTerminalBtn.disabled = state.viewMode === "terminal";
  dom.uploadComposerBtn.disabled = state.uploading;
  dom.uploadFilesBtn.disabled = state.uploading;
  dom.attachFileBtn.disabled = !state.currentFile;
  dom.ptyStatus.textContent = state.ptyAvailable ? "终端" : "管道";
  dom.ptyStatus.className = `status-pill ${state.ptyAvailable ? "connected" : "idle"}`;
}

function stripAnsi(text) {
  return String(text)
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[=>]/g, "")
    .replace(/\r/g, "");
}

function scrollTerminal() {
  if (dom.autoScrollToggle.checked) {
    dom.terminal.scrollTop = dom.terminal.scrollHeight;
  }
}

function trimTerminal() {
  while (dom.terminal.childNodes.length > 1600) {
    dom.terminal.removeChild(dom.terminal.firstChild);
  }
}

function appendOutput(data, kind = "stdout") {
  const cleaned = stripAnsi(data);
  if (!cleaned) {
    return;
  }
  const span = document.createElement("span");
  span.className = `terminal-chunk ${kind}`;
  span.textContent = cleaned;
  dom.terminal.appendChild(span);
  trimTerminal();
  scrollTerminal();
}

function appendEvent(message, kind = "event") {
  const line = document.createElement("div");
  line.className = `terminal-line ${kind}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  dom.terminal.appendChild(line);
  trimTerminal();
  scrollTerminal();
}

function compactText(text, maxLength = 56) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
}

function setSessionTitle(text) {
  const title = compactText(text, 48) || "新对话";
  state.sessionTitle = title;
  dom.stageTitleText.textContent = title;
}

function setCurrentCwd(cwd) {
  const nextCwd = String(cwd || "").trim() || "/root";
  state.currentCwd = nextCwd;
  dom.cwdInput.value = nextCwd;
  dom.activeCwd.textContent = nextCwd;
  saveStoredState();
}

function selectedHistorySession() {
  if (!state.currentHistoryId) {
    return null;
  }
  return state.currentHistorySession || state.historySessions.find((session) => session.id === state.currentHistoryId) || null;
}

function scrollChatStream() {
  if (dom.autoScrollToggle.checked) {
    dom.chatStream.scrollTop = dom.chatStream.scrollHeight;
  }
}

function trimChatStream() {
  while (dom.chatStream.childNodes.length > 260) {
    dom.chatStream.removeChild(dom.chatStream.firstChild);
  }
}

function clearChatOutputTarget() {
  state.activeChatOutput = null;
  state.activeChatOutputKind = "";
}

function appendChatStatus(message, kind = "status") {
  const row = document.createElement("div");
  row.className = `chat-status ${kind}`;
  row.textContent = message;
  dom.chatStream.appendChild(row);
  clearChatOutputTarget();
  trimChatStream();
  scrollChatStream();
}

function appendChatMessage(role, text, { attachments = [], tools = [] } = {}) {
  const article = document.createElement("article");
  article.className = `chat-message ${role}`;

  const label = document.createElement("div");
  label.className = "chat-role";
  label.textContent = role === "user" ? "你" : "Codex";
  article.appendChild(label);

  if (tools.length || attachments.length) {
    const context = document.createElement("div");
    context.className = "chat-context";
    for (const tool of tools) {
      const chip = document.createElement("span");
      chip.className = `chat-context-chip ${tool.type === "plugins" ? "plugin" : "skill"}`;
      chip.textContent = `${tool.type === "plugins" ? "插件" : "技能"} · ${tool.name}`;
      context.appendChild(chip);
    }
    for (const file of attachments) {
      const chip = document.createElement("span");
      chip.className = "chat-context-chip file";
      chip.textContent = file.name || fileNameFromPath(file.path);
      context.appendChild(chip);
    }
    article.appendChild(context);
  }

  const body = document.createElement("div");
  body.className = "chat-text";
  body.textContent = text || "请先阅读上下文，并等待我继续说明。";
  article.appendChild(body);

  dom.chatStream.appendChild(article);
  clearChatOutputTarget();
  trimChatStream();
  scrollChatStream();
}

function appendChatOutput(data, kind = "stdout") {
  const cleaned = stripAnsi(data);
  if (!cleaned.trim()) {
    return;
  }

  if (!state.activeChatOutput || state.activeChatOutputKind !== kind) {
    const article = document.createElement("article");
    article.className = `chat-message assistant output ${kind}`;

    const label = document.createElement("div");
    label.className = "chat-role";
    label.textContent = kind === "stderr" ? "错误输出" : "Codex";
    article.appendChild(label);

    const pre = document.createElement("pre");
    pre.className = "chat-output";
    article.appendChild(pre);
    dom.chatStream.appendChild(article);

    state.activeChatOutput = pre;
    state.activeChatOutputKind = kind;
  }

  state.activeChatOutput.textContent += cleaned;
  if (state.activeChatOutput.textContent.length > 24000) {
    state.activeChatOutput.textContent = `${state.activeChatOutput.textContent.slice(-24000)}`;
  }
  trimChatStream();
  scrollChatStream();
}

function parseArgs(input) {
  const args = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Codex 参数中有未闭合的引号");
  }
  if (current) {
    args.push(current);
  }
  return args;
}

function estimateTerminalSize() {
  const rect = dom.terminal.getBoundingClientRect();
  return {
    cols: Math.max(60, Math.floor(rect.width / 8)),
    rows: Math.max(18, Math.floor(rect.height / 20))
  };
}

function sendWs(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    appendEvent("通信通道未连接", "stderr");
    return false;
  }
  state.ws.send(JSON.stringify(payload));
  return true;
}

function sendInput(data, echo = true, preferredView = "chat") {
  if (preferredView === "terminal") {
    showTerminalView();
  } else {
    showChatView();
  }
  if (!state.running) {
    state.pendingInput = data;
    startSession();
    return;
  }
  if (echo) {
    appendOutput(`\n> ${data}`, "input");
  }
  sendWs({ type: "stdin", data });
}

function startSession() {
  if (!state.ready || state.running) {
    return;
  }
  showChatView();

  const resumeSession = selectedHistorySession();
  const resumeSessionId = resumeSession ? resumeSession.id : null;
  const cwd = dom.cwdInput.value.trim() || "/root";
  let args;
  try {
    args = parseArgs(dom.argsInput.value);
  } catch (err) {
    appendEvent(err.message, "stderr");
    return;
  }

  setCurrentCwd(cwd);
  const size = estimateTerminalSize();
  const requestedPty = dom.ptyToggle.checked;
  const actionLabel = resumeSessionId ? "继续历史对话" : "启动 Codex";
  appendEvent(`正在 ${cwd} ${actionLabel}`);
  appendChatStatus(`正在 ${cwd} ${actionLabel}`, "pending");
  sendWs({
    type: "start",
    cwd,
    args,
    resumeSessionId,
    pty: requestedPty,
    cols: size.cols,
    rows: size.rows
  });
}

function stopSession(signal = "SIGTERM") {
  if (!state.running) {
    return;
  }
  sendWs({ type: "stop", signal });
}

function newConversation() {
  if (state.running) {
    return;
  }
  state.currentHistoryId = null;
  state.currentHistorySession = null;
  state.currentHistoryMessages = [];
  state.historyHydratedId = null;
  state.selectedTools = [];
  clearAttachments();
  renderToolTray();
  dom.chatStream.replaceChildren();
  dom.terminal.replaceChildren();
  dom.historyViewer.replaceChildren();
  setSessionTitle("新对话");
  showChatView();
  appendChatStatus("新对话已创建", "done");
  startSession();
}

function formatMode(mode) {
  if (mode === "pty") {
    return "终端";
  }
  if (mode === "spawn") {
    return "管道";
  }
  return String(mode || "").toUpperCase();
}

function connectSocket() {
  if (state.ws && [WebSocket.OPEN, WebSocket.CONNECTING].includes(state.ws.readyState)) {
    return;
  }

  state.intentionalClose = false;
  clearTimeout(state.reconnectTimer);
  setSocketStatus("idle", "连接中");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  state.ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  state.ws.addEventListener("open", () => {
    setSocketStatus("connected", "已连接");
    setLastEvent("通信已连接");
  });

  state.ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "ready":
        state.ready = true;
        state.ptyAvailable = Boolean(message.pty);
        setSocketStatus("connected", "已连接");
        setProcessStatus("idle", "空闲");
        updateControls();
        break;
      case "started":
        state.running = true;
        clearChatOutputTarget();
        setProcessStatus("running", formatMode(message.mode));
        setLastEvent(`已启动 pid ${message.pid}`);
        appendEvent(`已启动 pid ${message.pid}（${formatMode(message.mode)}）`);
        appendChatStatus(message.resumeSessionId ? `已继续历史对话 ${message.resumeSessionId}` : `已启动 ${formatMode(message.mode)} 会话`, "ok");
        updateControls();
        if (state.pendingInput !== null) {
          const pending = state.pendingInput;
          state.pendingInput = null;
          window.setTimeout(() => sendInput(pending), 80);
        }
        break;
      case "stdout":
        appendOutput(message.data, "stdout");
        appendChatOutput(message.data, "stdout");
        break;
      case "stderr":
        appendOutput(message.data, "stderr");
        appendChatOutput(message.data, "stderr");
        break;
      case "exit":
        state.running = false;
        clearChatOutputTarget();
        setProcessStatus("idle", "空闲");
        setLastEvent(`已退出 ${message.code ?? ""}`);
        appendEvent(`进程已退出 code=${message.code ?? "null"} signal=${message.signal ?? "null"}`);
        appendChatStatus(`进程已退出 code=${message.code ?? "null"} signal=${message.signal ?? "null"}`, "done");
        updateControls();
        loadHistory();
        break;
      case "error":
        clearChatOutputTarget();
        setLastEvent(message.message);
        appendEvent(message.message, "stderr");
        appendChatStatus(message.message, "error");
        updateControls();
        break;
      default:
        appendEvent(`未知消息：${message.type}`, "stderr");
    }
  });

  state.ws.addEventListener("close", () => {
    state.ready = false;
    state.running = false;
    clearChatOutputTarget();
    setSocketStatus("disconnected", "离线");
    setProcessStatus("failed", "已关闭");
    appendChatStatus("通信已断开，正在等待重连", "pending");
    updateControls();
    if (!state.intentionalClose) {
      state.reconnectTimer = window.setTimeout(connectSocket, 1500);
    }
  });

  state.ws.addEventListener("error", () => {
    setSocketStatus("disconnected", "错误");
    appendEvent("通信通道错误", "stderr");
  });
}

function formatBytes(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return window.btoa(binary);
}

async function readUploadFile(file) {
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    throw new Error(`${file.name} 超过 ${formatBytes(MAX_UPLOAD_FILE_BYTES)}，无法上传`);
  }
  const buffer = await file.arrayBuffer();
  return {
    name: file.name,
    relativePath: file.webkitRelativePath || file.name,
    size: file.size,
    contentBase64: arrayBufferToBase64(buffer)
  };
}

function createEmptyState(text, className = "empty-state") {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function resizePromptInput() {
  dom.promptInput.style.height = "auto";
  const nextHeight = Math.min(Math.max(dom.promptInput.scrollHeight, 72), 180);
  dom.promptInput.style.height = `${nextHeight}px`;
}

function insertPromptText(text) {
  const snippet = String(text || "").trim();
  if (!snippet) {
    return;
  }

  const input = dom.promptInput;
  const current = input.value;
  const start = input.selectionStart ?? current.length;
  const end = input.selectionEnd ?? current.length;
  let insert = snippet;
  if (current.trim()) {
    const before = current.slice(0, start);
    const after = current.slice(end);
    const prefix = before && !before.endsWith("\n") ? "\n" : "";
    const suffix = after && !snippet.endsWith("\n") ? "\n" : "";
    input.value = `${before}${prefix}${insert}${suffix}${after}`;
    const cursor = before.length + prefix.length + insert.length;
    input.setSelectionRange(cursor, cursor);
  } else {
    input.value = insert;
    input.setSelectionRange(input.value.length, input.value.length);
  }
  resizePromptInput();
  input.focus();
}

function renderQuickActions() {
  const fragment = document.createDocumentFragment();
  for (const action of QUICK_PROMPTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-prompt";
    button.textContent = action.label;
    button.addEventListener("click", () => insertPromptText(action.text));
    fragment.appendChild(button);
  }
  dom.composerQuickActions.replaceChildren(fragment);
}

function catalogItems() {
  return state.catalogMode === "plugins" ? state.plugins : state.skills;
}

function catalogItemKey(type, item) {
  return `${type}:${item.id || item.name || item.displayName || item.path}`;
}

function catalogItemLabel(type, item) {
  return type === "plugins" ? (item.displayName || item.name || "未命名插件") : (item.name || item.title || "未命名技能");
}

function catalogItemTitle(type, item) {
  if (type === "plugins") {
    return item.displayName || item.name || "未命名插件";
  }
  return item.title && item.title !== item.name ? `${item.name} · ${item.title}` : (item.name || item.title || "未命名技能");
}

function catalogItemDescription(type, item) {
  const description = type === "plugins" ? (item.description || item.longDescription) : item.description;
  return description || "没有描述";
}

function catalogItemMeta(type, item) {
  if (type === "plugins") {
    return [
      item.category,
      item.developerName,
      Array.isArray(item.capabilities) && item.capabilities.length ? item.capabilities.join(" / ") : ""
    ].filter(Boolean).join(" · ");
  }
  return [
    item.source === "system" ? "系统技能" : "用户技能",
    item.directory || item.path
  ].filter(Boolean).join(" · ");
}

function catalogItemPrompt(type, item) {
  if (type === "plugins") {
    const prompts = Array.isArray(item.defaultPrompt) ? item.defaultPrompt : [];
    return prompts[0] || `请使用 ${catalogItemLabel(type, item)} 插件处理：`;
  }
  return `请使用 ${catalogItemLabel(type, item)} 技能处理：`;
}

function selectedCatalogItem() {
  if (!state.catalogSelected || state.catalogSelected.type !== state.catalogMode) {
    return null;
  }
  return catalogItems().find((item) => catalogItemKey(state.catalogMode, item) === state.catalogSelected.key) || null;
}

function setCatalogMode(mode) {
  state.catalogMode = mode === "plugins" ? "plugins" : "skills";
  state.catalogSelected = null;
  renderCatalog();
  dom.catalogSection.scrollIntoView({ block: "nearest" });
}

function matchesCatalogFilter(type, item, filter) {
  if (!filter) {
    return true;
  }
  const values = [
    catalogItemTitle(type, item),
    catalogItemDescription(type, item),
    catalogItemMeta(type, item),
    item.path,
    item.homepage
  ];
  return values.some((value) => String(value || "").toLowerCase().includes(filter));
}

function renderCatalogDetail() {
  const item = selectedCatalogItem();
  if (!item) {
    dom.catalogDetail.replaceChildren();
    dom.catalogDetail.classList.add("hidden");
    return;
  }

  const type = state.catalogMode;
  const fragment = document.createDocumentFragment();
  const title = document.createElement("div");
  title.className = "catalog-detail-title";
  title.textContent = catalogItemLabel(type, item);
  fragment.appendChild(title);

  const description = document.createElement("div");
  description.className = "catalog-detail-description";
  description.textContent = type === "plugins" ? (item.longDescription || catalogItemDescription(type, item)) : catalogItemDescription(type, item);
  fragment.appendChild(description);

  const meta = document.createElement("div");
  meta.className = "catalog-detail-meta";
  meta.textContent = [catalogItemMeta(type, item), item.path].filter(Boolean).join(" · ");
  fragment.appendChild(meta);

  if (type === "plugins" && Array.isArray(item.defaultPrompt) && item.defaultPrompt.length) {
    const promptList = document.createElement("div");
    promptList.className = "catalog-prompts";
    for (const prompt of item.defaultPrompt) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "catalog-prompt";
      button.textContent = prompt;
      button.addEventListener("click", () => {
        addSelectedTool(type, item);
        insertPromptText(prompt);
      });
      promptList.appendChild(button);
    }
    fragment.appendChild(promptList);
  }

  const actions = document.createElement("div");
  actions.className = "catalog-actions";
  const useButton = document.createElement("button");
  useButton.type = "button";
  useButton.className = "quiet-action catalog-action";
  useButton.textContent = "使用";
  useButton.addEventListener("click", () => {
    addSelectedTool(type, item);
    insertPromptText(catalogItemPrompt(type, item));
  });
  actions.appendChild(useButton);

  const attachButton = document.createElement("button");
  attachButton.type = "button";
  attachButton.className = "quiet-action catalog-action";
  attachButton.textContent = "仅加入";
  attachButton.addEventListener("click", () => addSelectedTool(type, item));
  actions.appendChild(attachButton);
  fragment.appendChild(actions);

  dom.catalogDetail.replaceChildren(fragment);
  dom.catalogDetail.classList.remove("hidden");
}

function renderCatalog() {
  const type = state.catalogMode;
  const isPlugins = type === "plugins";
  const filter = state.catalogFilter.trim().toLowerCase();
  const items = catalogItems().filter((item) => matchesCatalogFilter(type, item, filter));

  dom.catalogTitle.textContent = isPlugins ? "插件" : "技能";
  dom.catalogSkillsTab.classList.toggle("active", !isPlugins);
  dom.catalogPluginsTab.classList.toggle("active", isPlugins);
  dom.catalogSkillsTab.setAttribute("aria-selected", String(!isPlugins));
  dom.catalogPluginsTab.setAttribute("aria-selected", String(isPlugins));
  dom.skillsNavBtn.classList.toggle("active", !isPlugins);
  dom.pluginsNavBtn.classList.toggle("active", isPlugins);

  if (!items.length) {
    const text = catalogItems().length ? "没有匹配项" : (isPlugins ? "未发现插件" : "未发现技能");
    dom.catalogList.replaceChildren(createEmptyState(text));
    renderCatalogDetail();
    return;
  }

  const selectedVisible = state.catalogSelected
    && state.catalogSelected.type === type
    && items.some((item) => catalogItemKey(type, item) === state.catalogSelected.key);
  if (!selectedVisible) {
    state.catalogSelected = { type, key: catalogItemKey(type, items[0]) };
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const key = catalogItemKey(type, item);
    const row = document.createElement("article");
    row.className = `catalog-item${state.catalogSelected && state.catalogSelected.key === key ? " active" : ""}`;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "catalog-main";
    main.innerHTML = `
      <span class="catalog-name"></span>
      <span class="catalog-description"></span>
      <span class="catalog-meta"></span>
    `;
    main.querySelector(".catalog-name").textContent = catalogItemTitle(type, item);
    main.querySelector(".catalog-description").textContent = catalogItemDescription(type, item);
    main.querySelector(".catalog-meta").textContent = catalogItemMeta(type, item);
    main.addEventListener("click", () => {
      state.catalogSelected = { type, key };
      renderCatalog();
    });

    const use = document.createElement("button");
    use.type = "button";
    use.className = "catalog-use";
    use.textContent = "使用";
    use.addEventListener("click", () => {
      state.catalogSelected = { type, key };
      addSelectedTool(type, item);
      insertPromptText(catalogItemPrompt(type, item));
      renderCatalog();
    });

    row.append(main, use);
    fragment.appendChild(row);
  }

  dom.catalogList.replaceChildren(fragment);
  renderCatalogDetail();
}

async function loadCatalog() {
  dom.catalogList.replaceChildren(createEmptyState("正在加载...", "loading"));
  try {
    const [skillsData, pluginsData] = await Promise.all([
      api("/api/skills"),
      api("/api/plugins")
    ]);
    state.skills = skillsData.skills || [];
    state.plugins = pluginsData.plugins || [];
    renderCatalog();
  } catch (err) {
    dom.catalogList.replaceChildren(createEmptyState(err.message, "error-state"));
    dom.catalogDetail.replaceChildren();
    dom.catalogDetail.classList.add("hidden");
  }
}

function addSelectedTool(type, item) {
  const key = catalogItemKey(type, item);
  if (state.selectedTools.some((tool) => tool.key === key)) {
    renderToolTray();
    return;
  }

  state.selectedTools.push({
    key,
    type,
    name: catalogItemLabel(type, item),
    description: catalogItemDescription(type, item),
    prompt: catalogItemPrompt(type, item),
    path: item.path || ""
  });
  renderToolTray();
  setLastEvent(`已加入${type === "plugins" ? "插件" : "技能"}上下文`);
}

function removeSelectedTool(key) {
  state.selectedTools = state.selectedTools.filter((tool) => tool.key !== key);
  renderToolTray();
}

function renderToolTray() {
  if (!state.selectedTools.length) {
    dom.toolTray.replaceChildren();
    dom.toolTray.classList.add("hidden");
    renderSources();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const tool of state.selectedTools) {
    const chip = document.createElement("span");
    chip.className = `tool-chip ${tool.type === "plugins" ? "plugin" : "skill"}`;
    chip.innerHTML = `
      <span class="tool-kind"></span>
      <span class="tool-name"></span>
      <button class="tool-remove" type="button" title="移除" aria-label="移除">×</button>
    `;
    chip.querySelector(".tool-kind").textContent = tool.type === "plugins" ? "插件" : "技能";
    chip.querySelector(".tool-name").textContent = tool.name;
    chip.querySelector(".tool-remove").addEventListener("click", () => removeSelectedTool(tool.key));
    fragment.appendChild(chip);
  }
  dom.toolTray.replaceChildren(fragment);
  dom.toolTray.classList.remove("hidden");
  renderSources();
}

function renderSources() {
  const fragment = document.createDocumentFragment();
  const title = document.createElement("div");
  title.className = "source-title";
  title.textContent = "来源";
  fragment.appendChild(title);

  const sources = [
    ...state.selectedTools.map((tool) => ({
      kind: tool.type === "plugins" ? "插件" : "技能",
      name: tool.name,
      detail: tool.path
    })),
    ...state.attachments.map((file) => ({
      kind: "文件",
      name: file.name || fileNameFromPath(file.path),
      detail: file.path
    }))
  ];

  if (!sources.length) {
    const empty = document.createElement("div");
    empty.className = "source-empty";
    empty.textContent = "暂无来源";
    fragment.appendChild(empty);
    dom.sourceList.replaceChildren(fragment);
    return;
  }

  for (const source of sources.slice(0, 10)) {
    const row = document.createElement("div");
    row.className = "source-item";
    row.innerHTML = `
      <span class="source-kind"></span>
      <span class="source-main">
        <span class="source-name"></span>
        <span class="source-detail"></span>
      </span>
    `;
    row.querySelector(".source-kind").textContent = source.kind;
    row.querySelector(".source-name").textContent = source.name;
    row.querySelector(".source-detail").textContent = source.detail || "";
    fragment.appendChild(row);
  }

  dom.sourceList.replaceChildren(fragment);
}

function attachmentKey(file) {
  return file.path || file.name;
}

function addAttachment(file) {
  if (!file || !file.path) {
    return;
  }
  const key = attachmentKey(file);
  if (state.attachments.some((item) => attachmentKey(item) === key)) {
    return;
  }
  state.attachments.push({
    name: file.name || fileNameFromPath(file.path),
    path: file.path,
    size: file.size ?? null
  });
  renderAttachments();
}

function removeAttachment(path) {
  state.attachments = state.attachments.filter((item) => item.path !== path);
  renderAttachments();
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
}

function renderAttachments() {
  if (!state.attachments.length) {
    dom.attachmentTray.replaceChildren();
    dom.attachmentTray.classList.add("hidden");
    renderSources();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const attachment of state.attachments) {
    const chip = document.createElement("span");
    chip.className = "attachment-chip";
    chip.innerHTML = `
      <span class="attachment-name"></span>
      <span class="attachment-size"></span>
      <button class="attachment-remove" type="button" title="移除附件" aria-label="移除附件">×</button>
    `;
    chip.querySelector(".attachment-name").textContent = attachment.name;
    chip.querySelector(".attachment-size").textContent = attachment.size === null ? "" : formatBytes(attachment.size);
    chip.querySelector(".attachment-remove").addEventListener("click", () => removeAttachment(attachment.path));
    fragment.appendChild(chip);
  }
  dom.attachmentTray.replaceChildren(fragment);
  dom.attachmentTray.classList.remove("hidden");
  renderSources();
}

function renderRecentUploads() {
  if (!state.recentUploads.length) {
    dom.recentUploadList.replaceChildren();
    dom.recentUploadList.classList.add("hidden");
    return;
  }

  const fragment = document.createDocumentFragment();
  const title = document.createElement("div");
  title.className = "recent-title";
  title.textContent = "最近上传";
  fragment.appendChild(title);

  for (const file of state.recentUploads.slice(0, 5)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "recent-upload-item";
    row.innerHTML = `
      <span class="recent-name"></span>
      <span class="recent-size"></span>
    `;
    row.querySelector(".recent-name").textContent = file.name || fileNameFromPath(file.path);
    row.querySelector(".recent-size").textContent = formatBytes(file.size);
    row.addEventListener("click", () => {
      addAttachment(file);
      setLastEvent("已添加到上下文");
    });
    fragment.appendChild(row);
  }

  dom.recentUploadList.replaceChildren(fragment);
  dom.recentUploadList.classList.remove("hidden");
}

function addRecentUploads(files) {
  const incoming = Array.isArray(files) ? files : [];
  const merged = [...incoming, ...state.recentUploads];
  const seen = new Set();
  state.recentUploads = merged.filter((file) => {
    if (!file || !file.path || seen.has(file.path)) {
      return false;
    }
    seen.add(file.path);
    return true;
  }).slice(0, 12);
  renderRecentUploads();
}

function buildPromptPayload(value) {
  const trimmed = value.trim();
  const sections = [];

  if (state.selectedTools.length) {
    const tools = state.selectedTools
      .map((tool) => `- ${tool.type === "plugins" ? "插件" : "技能"}：${tool.name}${tool.path ? ` (${tool.path})` : ""}`)
      .join("\n");
    sections.push(`请优先使用以下技能/插件：\n${tools}`);
  }

  if (state.attachments.length) {
    const paths = state.attachments.map((item) => `- ${item.path}`).join("\n");
    sections.push(`请把以下文件作为本次任务上下文：\n${paths}`);
  }

  if (!sections.length) {
    return value;
  }

  const fallback = state.attachments.length
    ? "请先阅读这些文件，并等待我继续说明。"
    : "请根据上述技能或插件继续处理。";
  return `${sections.join("\n\n")}\n\n${trimmed || fallback}`;
}

function showChatView() {
  state.viewMode = "chat";
  dom.chatStream.classList.remove("hidden");
  dom.terminal.classList.add("hidden");
  dom.historyViewer.classList.add("hidden");
  updateControls();
}

function showTerminalView() {
  state.viewMode = "terminal";
  dom.chatStream.classList.add("hidden");
  dom.terminal.classList.remove("hidden");
  dom.historyViewer.classList.add("hidden");
  updateControls();
}

function showHistoryView() {
  state.viewMode = "history";
  dom.chatStream.classList.add("hidden");
  dom.terminal.classList.add("hidden");
  dom.historyViewer.classList.remove("hidden");
  updateControls();
}

function renderHistoryList() {
  const filter = state.historyFilter.trim().toLowerCase();
  const sessions = filter
    ? state.historySessions.filter((session) => [
      session.title,
      session.lastPrompt,
      session.cwd,
      session.file
    ].some((value) => String(value || "").toLowerCase().includes(filter)))
    : state.historySessions;

  if (!sessions.length) {
    dom.historyList.replaceChildren(createEmptyState(state.historySessions.length ? "没有匹配的历史记录" : "暂无历史记录"));
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `history-item${session.id === state.currentHistoryId ? " active" : ""}`;
    button.innerHTML = `
      <span class="history-title"></span>
      <span class="history-meta"></span>
      <span class="history-meta history-path"></span>
    `;
    button.querySelector(".history-title").textContent = session.title || "未命名会话";
    button.querySelector(".history-meta").textContent = `${formatDateTime(session.updatedAt || session.startedAt)} · ${session.messageCount} 条`;
    button.querySelector(".history-path").textContent = session.cwd || session.file || "";
    button.addEventListener("click", () => openHistory(session.id));
    fragment.appendChild(button);
  }
  dom.historyList.replaceChildren(fragment);
}

async function loadHistory() {
  dom.historyList.replaceChildren(createEmptyState("正在加载...", "loading"));
  try {
    const data = await api("/api/history");
    state.historySessions = data.sessions || [];
    if (state.currentHistoryId) {
      const selected = state.historySessions.find((session) => session.id === state.currentHistoryId);
      if (selected) {
        state.currentHistorySession = { ...(state.currentHistorySession || {}), ...selected };
      }
    }
    renderHistoryList();
  } catch (err) {
    dom.historyList.replaceChildren(createEmptyState(err.message, "error-state"));
  }
}

function hydrateChatFromHistory() {
  if (!state.currentHistoryId || state.historyHydratedId === state.currentHistoryId) {
    return;
  }

  dom.chatStream.replaceChildren();
  const messages = state.currentHistoryMessages || [];
  if (!messages.length) {
    appendChatStatus("历史上下文已选择", "done");
  } else {
    appendChatStatus("已载入历史上下文", "done");
    for (const message of messages) {
      appendChatMessage(message.role, message.text);
    }
  }
  state.historyHydratedId = state.currentHistoryId;
}

function continueHistorySession(session) {
  if (state.running || !session || !session.id) {
    return;
  }

  state.currentHistoryId = session.id;
  state.currentHistorySession = session;
  state.historyHydratedId = null;
  if (session.cwd) {
    setCurrentCwd(session.cwd);
    loadTree(session.cwd);
  }
  setSessionTitle(session.title || "历史会话");
  hydrateChatFromHistory();
  showChatView();
  startSession();
}

function renderHistorySession(data) {
  const fragment = document.createDocumentFragment();
  const header = document.createElement("div");
  header.className = "history-detail-header";
  header.innerHTML = `
    <div class="history-detail-title-row">
      <h3></h3>
      <button class="quiet-action history-resume-button" type="button">继续</button>
    </div>
    <div class="history-detail-meta"></div>
  `;
  header.querySelector("h3").textContent = data.session.title || "历史会话";
  const resumeButton = header.querySelector(".history-resume-button");
  resumeButton.disabled = state.running;
  resumeButton.addEventListener("click", () => continueHistorySession(data.session));
  header.querySelector(".history-detail-meta").textContent = [
    formatDateTime(data.session.startedAt),
    data.session.cwd,
    `${data.messages.length} 条消息`
  ].filter(Boolean).join(" · ");
  fragment.appendChild(header);

  if (!data.messages.length) {
    fragment.appendChild(createEmptyState("这个会话没有可显示的聊天消息"));
  } else {
    for (const message of data.messages) {
      const item = document.createElement("article");
      item.className = `history-message ${message.role}`;
      item.innerHTML = `
        <div class="history-role"></div>
        <pre class="history-text"></pre>
      `;
      item.querySelector(".history-role").textContent = message.role === "user" ? "用户" : "Codex";
      item.querySelector(".history-text").textContent = message.text;
      fragment.appendChild(item);
    }
  }

  dom.historyViewer.replaceChildren(fragment);
}

async function openHistory(id) {
  state.currentHistoryId = id;
  renderHistoryList();
  showHistoryView();
  dom.historyViewer.replaceChildren(createEmptyState("正在加载历史会话...", "loading"));
  try {
    const data = await api(`/api/history/session?id=${encodeURIComponent(id)}`);
    state.currentHistorySession = data.session;
    state.currentHistoryMessages = data.messages || [];
    state.historyHydratedId = null;
    if (data.session.cwd) {
      setCurrentCwd(data.session.cwd);
    }
    setSessionTitle(data.session.title || "历史会话");
    renderHistorySession(data);
    setLastEvent("正在查看历史记录");
  } catch (err) {
    dom.historyViewer.replaceChildren(createEmptyState(err.message, "error-state"));
  }
}

async function loadHealth() {
  try {
    const health = await api("/api/health");
    state.ptyAvailable = Boolean(health.pty);
    dom.ptyStatus.textContent = health.pty ? "终端" : "管道";
    dom.ptyStatus.className = `status-pill ${health.pty ? "connected" : "idle"}`;
  } catch (err) {
    dom.ptyStatus.textContent = "API";
    dom.ptyStatus.className = "status-pill failed";
    appendEvent(err.message, "stderr");
  }
}

function fileNameFromPath(filePath) {
  const parts = String(filePath || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || "新文件";
}

function parentPath(filePath) {
  const normalized = String(filePath || "").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/root";
  }
  return normalized.slice(0, index);
}

function defaultNewFilePath() {
  const base = (state.treePath || state.currentCwd || "/root").replace(/\/+$/, "");
  return `${base || "/root"}/untitled.txt`;
}

function setFileMeta(message, kind = "") {
  dom.fileMeta.className = `file-meta${kind ? ` ${kind}` : ""}`;
  dom.fileMeta.textContent = message;
}

function updateEditorControls() {
  const editorEnabled = !dom.fileEditor.disabled;
  const pathValue = dom.filePathInput.value.trim();
  dom.saveFileBtn.disabled = !editorEnabled || !pathValue || !state.fileDirty;
  dom.reloadFileBtn.disabled = !state.currentFile;
  dom.attachFileBtn.disabled = !state.currentFile;
  dom.filePathInput.disabled = !editorEnabled;
  dom.fileMeta.classList.toggle("dirty", state.fileDirty);

  if (!editorEnabled) {
    dom.editorTitle.textContent = "预览";
    return;
  }

  const name = fileNameFromPath(pathValue || state.currentFileName);
  dom.editorTitle.textContent = `${name}${state.fileDirty ? " *" : ""}`;
}

function refreshDirtyState() {
  if (dom.fileEditor.disabled) {
    state.fileDirty = false;
    updateEditorControls();
    return;
  }

  const pathValue = dom.filePathInput.value.trim();
  const pathChanged = state.currentFile ? pathValue !== state.currentFile : Boolean(pathValue);
  const contentChanged = dom.fileEditor.value !== state.lastSavedContent;
  state.fileDirty = pathChanged || contentChanged;
  updateEditorControls();
}

function confirmDiscardChanges() {
  if (!state.fileDirty) {
    return true;
  }
  return window.confirm("当前文件有未保存更改，确定要放弃吗？");
}

function resetEditor(message = "未选择文件", kind = "") {
  state.currentFile = null;
  state.currentFileName = "";
  state.lastSavedContent = "";
  state.fileDirty = false;
  dom.filePathInput.value = "";
  dom.filePathInput.disabled = true;
  dom.fileEditor.value = "";
  dom.fileEditor.disabled = true;
  setFileMeta(message, kind);
  updateEditorControls();
}

function newFile() {
  if (!confirmDiscardChanges()) {
    return;
  }

  state.currentFile = null;
  state.currentFileName = "untitled.txt";
  state.lastSavedContent = "";
  dom.filePathInput.value = defaultNewFilePath();
  dom.fileEditor.value = "";
  dom.fileEditor.disabled = false;
  setFileMeta("新文件，保存后写入指定路径");
  state.fileDirty = true;
  updateEditorControls();
  dom.filePathInput.focus();
  dom.filePathInput.select();
}

async function loadProjects() {
  dom.projectList.replaceChildren(createEmptyState("正在加载...", "loading"));
  try {
    const data = await api("/api/projects");
    if (!data.projects.length) {
      dom.projectList.replaceChildren(createEmptyState("未找到项目"));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const project of data.projects) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `project-item${project.path === state.currentCwd ? " active" : ""}`;
      button.innerHTML = `
        <span class="project-name"></span>
        <span class="project-path"></span>
        <span class="project-markers"></span>
      `;
      button.querySelector(".project-name").textContent = project.name;
      button.querySelector(".project-path").textContent = project.path;
      button.querySelector(".project-markers").textContent = project.markers.length ? project.markers.join("  ") : "根目录";
      button.addEventListener("click", () => {
        if (!confirmDiscardChanges()) {
          return;
        }
        state.currentCwd = project.path;
        dom.cwdInput.value = project.path;
        dom.activeCwd.textContent = project.path;
        saveStoredState();
        loadTree(project.path);
        loadProjects();
      });
      fragment.appendChild(button);
    }
    dom.projectList.replaceChildren(fragment);
  } catch (err) {
    dom.projectList.replaceChildren(createEmptyState(err.message, "error-state"));
  }
}

async function loadTree(inputPath = state.treePath) {
  const path = inputPath || "/root";
  dom.fileTree.replaceChildren(createEmptyState("正在加载...", "loading"));
  dom.treePathInput.value = path;
  try {
    const data = await api(`/api/tree?path=${encodeURIComponent(path)}`);
    state.treePath = data.path;
    state.treeParent = data.parent;
    dom.treePathInput.value = data.path;
    dom.upDirBtn.disabled = !data.parent;

    if (!data.items.length) {
      dom.fileTree.replaceChildren(createEmptyState("目录为空"));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const item of data.items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `file-row ${item.type}${state.currentFile === item.path ? " active" : ""}`;
      row.innerHTML = `
        <span class="file-name"></span>
        <span class="file-detail"></span>
      `;
      row.querySelector(".file-name").textContent = item.type === "directory" ? `${item.name}/` : item.name;
      row.querySelector(".file-detail").textContent = item.type === "file" ? formatBytes(item.size) : "";
      row.addEventListener("click", () => {
        if (item.type === "directory") {
          loadTree(item.path);
        } else if (item.type === "file") {
          openFile(item.path);
        }
      });
      fragment.appendChild(row);
    }

    if (data.truncated) {
      fragment.appendChild(createEmptyState("目录内容已截断", "loading"));
    }
    dom.fileTree.replaceChildren(fragment);
  } catch (err) {
    dom.fileTree.replaceChildren(createEmptyState(err.message, "error-state"));
  }
}

async function openFile(path) {
  if (!confirmDiscardChanges()) {
    return;
  }

  setFileMeta("正在加载...");
  dom.fileEditor.disabled = true;
  dom.filePathInput.disabled = true;
  dom.saveFileBtn.disabled = true;
  dom.reloadFileBtn.disabled = true;
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(path)}`);
    state.currentFile = data.path;
    state.currentFileName = data.name;
    state.lastSavedContent = data.content;
    state.fileDirty = false;
    dom.filePathInput.value = data.path;
    setFileMeta(`${data.path}  ${formatBytes(data.size)}`);
    dom.fileEditor.value = data.content;
    dom.fileEditor.disabled = false;
    updateEditorControls();
    loadTree(state.treePath);
  } catch (err) {
    resetEditor(err.message, "error-state");
  }
}

async function saveFile() {
  const targetPath = dom.filePathInput.value.trim();
  if (!targetPath || dom.fileEditor.disabled) {
    setFileMeta("请先输入文件路径", "error-state");
    return;
  }

  dom.saveFileBtn.disabled = true;
  setFileMeta("正在保存...");
  try {
    const data = await api("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path: targetPath, content: dom.fileEditor.value })
    });
    state.currentFile = data.path;
    state.currentFileName = data.name;
    state.lastSavedContent = dom.fileEditor.value;
    state.fileDirty = false;
    dom.filePathInput.value = data.path;
    setFileMeta(`${data.path}  ${formatBytes(data.size)}`);
    updateEditorControls();
    loadTree(parentPath(data.path));
  } catch (err) {
    setFileMeta(err.message, "error-state");
    updateEditorControls();
  }
}

function openUploadPicker() {
  if (state.uploading) {
    return;
  }
  dom.uploadInput.value = "";
  dom.uploadInput.click();
}

function attachCurrentFile() {
  if (!state.currentFile) {
    return;
  }
  addAttachment({
    name: state.currentFileName || fileNameFromPath(state.currentFile),
    path: state.currentFile,
    size: null
  });
  setLastEvent("已添加到上下文");
}

async function uploadSelectedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) {
    return;
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
    setLastEvent(`上传总大小超过 ${formatBytes(MAX_UPLOAD_TOTAL_BYTES)}`);
    return;
  }

  state.uploading = true;
  updateControls();
  setLastEvent(`正在上传 ${files.length} 个文件...`);
  try {
    const payloadFiles = [];
    for (const file of files) {
      payloadFiles.push(await readUploadFile(file));
    }
    const data = await api("/api/upload", {
      method: "POST",
      body: JSON.stringify({
        path: state.treePath || state.currentCwd || "/root",
        files: payloadFiles
      })
    });
    setLastEvent(`已上传 ${data.count} 个文件，${formatBytes(data.totalBytes)}`);
    addRecentUploads(data.files || []);
    for (const file of data.files || []) {
      addAttachment(file);
    }
    await loadTree(data.path || state.treePath);
  } catch (err) {
    setLastEvent(`上传失败：${err.message}`);
    appendEvent(`上传失败：${err.message}`, "stderr");
  } finally {
    state.uploading = false;
    updateControls();
    dom.uploadInput.value = "";
  }
}

function handleDragOver(event) {
  event.preventDefault();
  if (state.uploading) {
    return;
  }
  dom.promptForm.classList.add("drag-over");
}

function handleDragLeave(event) {
  if (!dom.promptForm.contains(event.relatedTarget)) {
    dom.promptForm.classList.remove("drag-over");
  }
}

function handleDrop(event) {
  event.preventDefault();
  dom.promptForm.classList.remove("drag-over");
  if (event.dataTransfer && event.dataTransfer.files.length) {
    uploadSelectedFiles(event.dataTransfer.files);
  }
}

function bindEvents() {
  dom.startBtn.addEventListener("click", newConversation);
  dom.stopBtn.addEventListener("click", () => stopSession());
  dom.sendInterruptBtn.addEventListener("click", () => sendInput("\x03", false, "terminal"));
  dom.sendEnterBtn.addEventListener("click", () => sendInput("\n", false, "terminal"));
  dom.sendRawBtn.addEventListener("click", () => sendInput(dom.promptInput.value, false, "terminal"));

  dom.promptForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = dom.promptInput.value;
    if (!value.trim() && !state.attachments.length && !state.selectedTools.length) {
      return;
    }
    const attachments = state.attachments.map((item) => ({ ...item }));
    const tools = state.selectedTools.map((item) => ({ ...item }));
    const visibleText = value.trim() || (attachments.length ? "请先阅读这些文件。" : "请根据已选择的技能或插件继续处理。");
    const resumeSession = selectedHistorySession();
    if (resumeSession) {
      setSessionTitle(resumeSession.title || visibleText);
      hydrateChatFromHistory();
    } else {
      setSessionTitle(visibleText);
    }
    showChatView();
    appendChatMessage("user", visibleText, { attachments, tools });
    appendChatStatus("正在思考", "pending");
    sendInput(`${buildPromptPayload(value)}\n`, true, "chat");
    dom.promptInput.value = "";
    resizePromptInput();
    clearAttachments();
  });

  dom.promptInput.addEventListener("keydown", (event) => {
    if (event.isComposing || event.key !== "Enter") {
      return;
    }
    if (!event.shiftKey && !event.altKey) {
      event.preventDefault();
      dom.promptForm.requestSubmit();
    }
  });
  dom.promptInput.addEventListener("input", resizePromptInput);
  dom.promptInput.addEventListener("paste", (event) => {
    const files = event.clipboardData && event.clipboardData.files;
    if (files && files.length) {
      uploadSelectedFiles(files);
    }
  });
  dom.promptForm.addEventListener("dragover", handleDragOver);
  dom.promptForm.addEventListener("dragleave", handleDragLeave);
  dom.promptForm.addEventListener("drop", handleDrop);

  dom.cwdInput.addEventListener("change", () => {
    const cwd = dom.cwdInput.value.trim() || "/root";
    state.currentCwd = cwd;
    dom.activeCwd.textContent = cwd;
    saveStoredState();
  });

  dom.treePathInput.addEventListener("change", () => loadTree(dom.treePathInput.value.trim() || "/root"));
  dom.upDirBtn.addEventListener("click", () => {
    if (state.treeParent) {
      loadTree(state.treeParent);
    }
  });
  dom.refreshTreeBtn.addEventListener("click", () => loadTree(state.treePath));
  dom.refreshProjectsBtn.addEventListener("click", loadProjects);
  dom.refreshCatalogBtn.addEventListener("click", loadCatalog);
  dom.refreshHistoryBtn.addEventListener("click", loadHistory);
  dom.searchNavBtn.addEventListener("click", () => {
    dom.historySearchInput.focus();
    dom.historySearchInput.select();
  });
  dom.skillsNavBtn.addEventListener("click", () => setCatalogMode("skills"));
  dom.pluginsNavBtn.addEventListener("click", () => setCatalogMode("plugins"));
  dom.catalogSkillsTab.addEventListener("click", () => setCatalogMode("skills"));
  dom.catalogPluginsTab.addEventListener("click", () => setCatalogMode("plugins"));
  dom.catalogSearchInput.addEventListener("input", () => {
    state.catalogFilter = dom.catalogSearchInput.value;
    state.catalogSelected = null;
    renderCatalog();
  });
  dom.historySearchInput.addEventListener("input", () => {
    state.historyFilter = dom.historySearchInput.value;
    renderHistoryList();
  });
  dom.uploadComposerBtn.addEventListener("click", openUploadPicker);
  dom.uploadFilesBtn.addEventListener("click", openUploadPicker);
  dom.uploadInput.addEventListener("change", () => uploadSelectedFiles(dom.uploadInput.files));
  dom.showChatBtn.addEventListener("click", () => {
    showChatView();
    setLastEvent("聊天视图");
  });
  dom.showTerminalBtn.addEventListener("click", () => {
    showTerminalView();
    setLastEvent("终端视图");
  });
  dom.newFileBtn.addEventListener("click", newFile);
  dom.attachFileBtn.addEventListener("click", attachCurrentFile);
  dom.reloadFileBtn.addEventListener("click", () => state.currentFile && openFile(state.currentFile));
  dom.saveFileBtn.addEventListener("click", saveFile);
  dom.fileEditor.addEventListener("input", refreshDirtyState);
  dom.filePathInput.addEventListener("input", refreshDirtyState);
  dom.clearLogBtn.addEventListener("click", () => {
    if (state.viewMode === "chat") {
      dom.chatStream.replaceChildren();
      setSessionTitle("新对话");
      appendChatStatus("聊天已清空", "done");
      setLastEvent("聊天已清空");
      return;
    }
    if (state.viewMode === "history") {
      dom.historyViewer.replaceChildren();
      state.currentHistoryId = null;
      state.currentHistorySession = null;
      state.currentHistoryMessages = [];
      state.historyHydratedId = null;
      renderHistoryList();
      setLastEvent("历史视图已清空");
      return;
    }
    dom.terminal.replaceChildren();
    appendEvent("终端已清空");
  });
  dom.copyLogBtn.addEventListener("click", async () => {
    try {
      const source = state.viewMode === "history" ? dom.historyViewer : state.viewMode === "chat" ? dom.chatStream : dom.terminal;
      await navigator.clipboard.writeText(source.textContent || "");
      setLastEvent(state.viewMode === "history" ? "历史记录已复制" : state.viewMode === "chat" ? "聊天记录已复制" : "终端日志已复制");
    } catch (err) {
      appendEvent(`复制失败：${err.message}`, "stderr");
    }
  });

  for (const node of [dom.argsInput, dom.ptyToggle, dom.autoScrollToggle, dom.sessionNotes]) {
    node.addEventListener("input", saveStoredState);
    node.addEventListener("change", saveStoredState);
  }

  const resizeObserver = new ResizeObserver(() => {
    if (!state.running) {
      return;
    }
    sendWs({ type: "resize", ...estimateTerminalSize() });
  });
  resizeObserver.observe(dom.terminal);

  window.addEventListener("beforeunload", (event) => {
    if (state.fileDirty) {
      event.preventDefault();
      event.returnValue = "";
      return;
    }
    state.intentionalClose = true;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.close();
    }
  });
}

async function init() {
  loadStoredState();
  bindEvents();
  renderQuickActions();
  renderToolTray();
  resizePromptInput();
  setSessionTitle("新对话");
  appendEvent("Codex Web 已就绪");
  appendChatStatus("Codex Web 已就绪", "done");
  setSocketStatus("disconnected", "离线");
  setProcessStatus("idle", "空闲");
  resetEditor();
  updateControls();
  await loadHealth();
  connectSocket();
  await Promise.all([loadProjects(), loadHistory(), loadTree(state.treePath), loadCatalog()]);
}

init();
