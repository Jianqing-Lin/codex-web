"use strict";

const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "8686", 10);
const ROOT_DIR = "/root";
const PUBLIC_DIR = path.join(__dirname, "public");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_HOME = process.env.CODEX_HOME || path.join(ROOT_DIR, ".codex");
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, "sessions");
const CODEX_HISTORY_FILE = path.join(CODEX_HOME, "history.jsonl");
const CODEX_SKILLS_DIR = path.join(CODEX_HOME, "skills");
const CODEX_PLUGINS_DIR = path.join(CODEX_HOME, ".tmp", "plugins", "plugins");
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 40 * 1024 * 1024;
const MAX_UPLOAD_FILE_BYTES = 20 * 1024 * 1024;
const MAX_HISTORY_FILE_BYTES = 6 * 1024 * 1024;
const MAX_HISTORY_SESSIONS = 150;
const MAX_DIR_ENTRIES = 500;
const MAX_CATALOG_ITEMS = 500;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
const MAX_PLUGIN_FILE_BYTES = 512 * 1024;

let pty = null;
try {
  pty = require("node-pty");
} catch (_err) {
  pty = null;
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function normalizeCwd(input) {
  const requested = typeof input === "string" && input.trim() ? input : ROOT_DIR;
  const resolved = path.resolve(ROOT_DIR, requested);
  const relative = path.relative(ROOT_DIR, resolved);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error("工作区必须位于 /root 内");
}

function normalizeRootPath(input) {
  const requested = typeof input === "string" && input.trim() ? input : ROOT_DIR;
  const resolved = path.resolve(ROOT_DIR, requested);
  const relative = path.relative(ROOT_DIR, resolved);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return resolved;
  }

  throw new Error("路径必须位于 /root 内");
}

function toClientPath(absPath) {
  return absPath;
}

function sanitizeEnv(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`环境变量名无效：${key}`);
    }
    if (value === null || value === undefined) {
      continue;
    }
    env[key] = String(value);
  }
  return env;
}

function sanitizeArgs(input) {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new Error("参数必须是数组");
  }
  return input.map((arg) => {
    if (typeof arg !== "string") {
      throw new Error("参数数组只能包含字符串");
    }
    if (arg.includes("\0")) {
      throw new Error("参数不能包含 NUL 字节");
    }
    return arg;
  });
}

function sanitizeSessionId(input) {
  if (input === undefined || input === null || input === "") {
    return null;
  }
  const value = String(input).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("历史会话 ID 无效");
  }
  return value;
}

function sanitizeModel(input) {
  if (input === undefined || input === null || input === "") {
    return "";
  }
  const value = String(input).trim();
  if (!value) {
    return "";
  }
  if (value.includes("\0") || !/^[A-Za-z0-9._:/+-]{1,128}$/.test(value)) {
    throw new Error("模型名称无效");
  }
  return value;
}

function sanitizePrompt(input) {
  const value = String(input || "");
  if (Buffer.byteLength(value, "utf8") > MAX_PROMPT_BYTES) {
    throw new Error("提示内容过大");
  }
  return value;
}

function modelArgs(model) {
  return model ? ["-m", model] : [];
}

function buildCodexArgs(args, resumeSessionId, model) {
  const runArgs = [...args, ...modelArgs(model)];
  if (!resumeSessionId) {
    return runArgs;
  }
  return ["resume", ...runArgs, resumeSessionId];
}

function buildExecArgs(args, resumeSessionId, model) {
  const runArgs = [...args, ...modelArgs(model)];
  if (resumeSessionId) {
    return ["exec", ...runArgs, "resume", resumeSessionId, "-"];
  }
  return ["exec", ...runArgs, "-"];
}

function collectJson(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        reject(new Error("请求内容过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_err) {
        reject(new Error("请求内容必须是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function pathExists(absPath) {
  try {
    await fsp.access(absPath);
    return true;
  } catch (_err) {
    return false;
  }
}

async function collectSessionFiles(dir = CODEX_SESSIONS_DIR) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSessionFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

function extractSessionId(filePath, meta) {
  if (meta && typeof meta.id === "string" && meta.id) {
    return meta.id;
  }
  const match = path.basename(filePath).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : path.basename(filePath, ".jsonl");
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isVisibleChatMessage(role, text) {
  const trimmed = text.trim();
  if (!trimmed || !["user", "assistant"].includes(role)) {
    return false;
  }
  if (role === "user" && trimmed.startsWith("<environment_context>")) {
    return false;
  }
  return true;
}

function summarizeText(text, maxLength = 96) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}…`;
}

function stripQuotes(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(text) {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { meta: {}, body: normalized };
  }

  const endIndex = normalized.indexOf("\n---", 4);
  if (endIndex === -1) {
    return { meta: {}, body: normalized };
  }

  const block = normalized.slice(4, endIndex).trim();
  const bodyStart = normalized.indexOf("\n", endIndex + 4);
  const meta = {};
  for (const line of block.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    meta[match[1]] = stripQuotes(match[2]);
  }

  return {
    meta,
    body: bodyStart === -1 ? "" : normalized.slice(bodyStart + 1).trim()
  };
}

function firstMarkdownHeading(markdown) {
  const match = String(markdown || "").match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function firstMarkdownParagraph(markdown) {
  const withoutHeadings = String(markdown || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("- ") && !line.startsWith("```"));
  return summarizeText(withoutHeadings[0] || "", 220);
}

async function readPromptHistory() {
  const promptsBySession = new Map();
  let content = "";
  try {
    content = await fsp.readFile(CODEX_HISTORY_FILE, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return promptsBySession;
    }
    throw err;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (typeof record.session_id !== "string" || typeof record.text !== "string") {
        continue;
      }
      const prompts = promptsBySession.get(record.session_id) || [];
      prompts.push({ text: record.text, ts: record.ts || null });
      promptsBySession.set(record.session_id, prompts);
    } catch (_err) {
      continue;
    }
  }
  return promptsBySession;
}

async function parseHistorySessionFile(filePath, { includeMessages = false, prompts = [] } = {}) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_HISTORY_FILE_BYTES) {
    const err = new Error(`历史会话文件超过 ${MAX_HISTORY_FILE_BYTES} 字节，暂不加载`);
    err.statusCode = 413;
    throw err;
  }

  let meta = null;
  let firstUserText = "";
  let lastUserText = "";
  let messageCount = 0;
  const messages = [];
  const content = await fsp.readFile(filePath, "utf8");

  for (const line of content.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch (_err) {
      continue;
    }

    const payload = record.payload || {};
    if (record.type === "session_meta") {
      meta = payload;
      continue;
    }
    if (record.type !== "response_item" || payload.type !== "message") {
      continue;
    }

    const role = payload.role;
    const text = extractMessageText(payload.content);
    if (!isVisibleChatMessage(role, text)) {
      continue;
    }

    messageCount += 1;
    if (role === "user") {
      firstUserText = firstUserText || text;
      lastUserText = text;
    }
    if (includeMessages) {
      messages.push({
        role,
        text,
        phase: payload.phase || "",
        timestamp: record.timestamp || payload.timestamp || null
      });
    }
  }

  const id = extractSessionId(filePath, meta);
  const promptTitle = prompts.length ? prompts[0].text : "";
  const title = summarizeText(promptTitle || firstUserText || path.basename(filePath, ".jsonl"));
  const updatedAt = prompts.length && prompts[prompts.length - 1].ts
    ? new Date(prompts[prompts.length - 1].ts * 1000).toISOString()
    : stat.mtime.toISOString();

  const session = {
    id,
    title,
    cwd: meta && meta.cwd ? meta.cwd : "",
    startedAt: meta && meta.timestamp ? meta.timestamp : null,
    updatedAt,
    messageCount,
    promptCount: prompts.length,
    lastPrompt: summarizeText(lastUserText || (prompts.at(-1) && prompts.at(-1).text) || ""),
    file: toClientPath(filePath),
    size: stat.size
  };

  return includeMessages ? { session, messages } : session;
}

async function listHistorySessions() {
  const [files, promptsBySession] = await Promise.all([
    collectSessionFiles(),
    readPromptHistory()
  ]);

  const sessions = [];
  for (const filePath of files) {
    try {
      const basenameId = extractSessionId(filePath, null);
      const session = await parseHistorySessionFile(filePath, {
        prompts: promptsBySession.get(basenameId) || []
      });
      const prompts = promptsBySession.get(session.id);
      if (prompts && prompts.length && !session.promptCount) {
        const reparsed = await parseHistorySessionFile(filePath, { prompts });
        sessions.push(reparsed);
      } else {
        sessions.push(session);
      }
    } catch (_err) {
      continue;
    }
  }

  sessions.sort((a, b) => new Date(b.updatedAt || b.startedAt || 0) - new Date(a.updatedAt || a.startedAt || 0));
  return sessions.slice(0, MAX_HISTORY_SESSIONS);
}

async function readHistorySession(id) {
  if (typeof id !== "string" || !/^[0-9a-f-]{16,}$/i.test(id)) {
    throw new Error("历史会话 ID 无效");
  }

  const [files, promptsBySession] = await Promise.all([
    collectSessionFiles(),
    readPromptHistory()
  ]);
  const filePath = files.find((candidate) => path.basename(candidate).includes(id));
  if (!filePath) {
    const err = new Error("历史会话不存在");
    err.statusCode = 404;
    throw err;
  }

  return parseHistorySessionFile(filePath, {
    includeMessages: true,
    prompts: promptsBySession.get(id) || []
  });
}

async function getProjectSummary(absPath) {
  const stat = await fsp.stat(absPath);
  if (!stat.isDirectory()) {
    return null;
  }

  const markers = await Promise.all([
    pathExists(path.join(absPath, ".git")),
    pathExists(path.join(absPath, "package.json")),
    pathExists(path.join(absPath, "pyproject.toml")),
    pathExists(path.join(absPath, "Cargo.toml")),
    pathExists(path.join(absPath, "go.mod"))
  ]);

  const names = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
  return {
    name: path.basename(absPath) || absPath,
    path: toClientPath(absPath),
    mtimeMs: stat.mtimeMs,
    markers: names.filter((_name, index) => markers[index])
  };
}

async function discoverProjects() {
  const projects = [];
  const rootProject = await getProjectSummary(ROOT_DIR);
  if (rootProject) {
    projects.push({ ...rootProject, name: "根目录" });
  }

  const entries = await fsp.readdir(ROOT_DIR, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !["node_modules", ".cache", ".npm"].includes(entry.name))
    .slice(0, 100);

  for (const entry of directories) {
    const absPath = path.join(ROOT_DIR, entry.name);
    const project = await getProjectSummary(absPath);
    if (project && (project.markers.length > 0 || entry.name === "codex-web")) {
      projects.push(project);
    }
  }

  projects.sort((a, b) => Number(b.markers.includes(".git")) - Number(a.markers.includes(".git")) || b.mtimeMs - a.mtimeMs);
  return projects;
}

async function listDirectory(inputPath) {
  const absPath = normalizeRootPath(inputPath);
  const stat = await fsp.stat(absPath);
  if (!stat.isDirectory()) {
    throw new Error("路径不是目录");
  }

  const entries = await fsp.readdir(absPath, { withFileTypes: true });
  const limited = entries
    .filter((entry) => ![".git", "node_modules"].includes(entry.name))
    .slice(0, MAX_DIR_ENTRIES);

  const items = await Promise.all(limited.map(async (entry) => {
    const entryPath = path.join(absPath, entry.name);
    let entryStat = null;
    try {
      entryStat = await fsp.stat(entryPath);
    } catch (_err) {
      entryStat = null;
    }

    return {
      name: entry.name,
      path: toClientPath(entryPath),
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      size: entryStat ? entryStat.size : null,
      mtimeMs: entryStat ? entryStat.mtimeMs : null
    };
  }));

  items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return {
    path: toClientPath(absPath),
    parent: absPath === ROOT_DIR ? null : toClientPath(path.dirname(absPath)),
    truncated: entries.length > limited.length,
    items
  };
}

function looksBinary(buffer) {
  const length = Math.min(buffer.length, 8000);
  for (let index = 0; index < length; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

async function readTextFile(inputPath) {
  const absPath = normalizeRootPath(inputPath);
  const stat = await fsp.stat(absPath);
  if (!stat.isFile()) {
    throw new Error("路径不是文件");
  }
  if (stat.size > MAX_FILE_BYTES) {
    const err = new Error(`文件超过 ${MAX_FILE_BYTES} 字节，无法预览`);
    err.statusCode = 413;
    throw err;
  }

  const buffer = await fsp.readFile(absPath);
  if (looksBinary(buffer)) {
    const err = new Error("二进制文件无法在这里预览");
    err.statusCode = 415;
    throw err;
  }

  return {
    path: toClientPath(absPath),
    name: path.basename(absPath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    content: buffer.toString("utf8")
  };
}

async function writeTextFile(inputPath, content) {
  const absPath = normalizeRootPath(inputPath);
  if (typeof content !== "string") {
    throw new Error("文件内容必须是字符串");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_BODY_BYTES) {
    const err = new Error("文件内容过大");
    err.statusCode = 413;
    throw err;
  }

  await fsp.mkdir(path.dirname(absPath), { recursive: true });
  await fsp.writeFile(absPath, content, "utf8");
  const stat = await fsp.stat(absPath);
  return {
    path: toClientPath(absPath),
    name: path.basename(absPath),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function normalizeUploadRelativePath(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("上传文件名不能为空");
  }

  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("\0")) {
    throw new Error("上传文件名不能包含 NUL 字节");
  }

  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`上传路径无效：${input}`);
  }
  return parts.join("/");
}

function decodeUploadContent(file) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error("上传文件格式无效");
  }
  if (typeof file.contentBase64 !== "string") {
    throw new Error("上传内容必须是 base64 字符串");
  }

  const buffer = Buffer.from(file.contentBase64, "base64");
  if (buffer.length > MAX_UPLOAD_FILE_BYTES) {
    const err = new Error(`单个上传文件不能超过 ${MAX_UPLOAD_FILE_BYTES} 字节`);
    err.statusCode = 413;
    throw err;
  }
  return buffer;
}

async function uploadFiles(inputPath, files) {
  const targetDir = normalizeRootPath(inputPath);
  const dirStat = await fsp.stat(targetDir).catch(() => null);
  if (dirStat && !dirStat.isDirectory()) {
    throw new Error("上传目标不是目录");
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("没有选择要上传的文件");
  }
  if (files.length > 40) {
    throw new Error("一次最多上传 40 个文件");
  }

  let totalBytes = 0;
  const uploaded = [];
  for (const file of files) {
    const relativePath = normalizeUploadRelativePath(file.relativePath || file.name);
    const buffer = decodeUploadContent(file);
    totalBytes += buffer.length;
    if (totalBytes > MAX_UPLOAD_BODY_BYTES) {
      const err = new Error(`上传总大小不能超过 ${MAX_UPLOAD_BODY_BYTES} 字节`);
      err.statusCode = 413;
      throw err;
    }

    const absPath = path.resolve(targetDir, relativePath);
    const relativeToRoot = path.relative(ROOT_DIR, absPath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      throw new Error("上传路径必须位于 /root 内");
    }

    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, buffer);
    uploaded.push({
      name: path.basename(absPath),
      path: toClientPath(absPath),
      size: buffer.length
    });
  }

  return {
    path: toClientPath(targetDir),
    count: uploaded.length,
    totalBytes,
    files: uploaded
  };
}

async function collectSkillManifests(dir = CODEX_SKILLS_DIR, depth = 0) {
  if (depth > 6) {
    return [];
  }

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSkillManifests(entryPath, depth + 1));
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(entryPath);
    }
    if (files.length >= MAX_CATALOG_ITEMS) {
      break;
    }
  }
  return files.slice(0, MAX_CATALOG_ITEMS);
}

async function readSkillManifest(filePath) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    return null;
  }

  const content = await fsp.readFile(filePath, "utf8");
  const parsed = parseFrontmatter(content);
  const relativePath = path.relative(CODEX_SKILLS_DIR, filePath);
  const directory = path.dirname(relativePath);
  const name = parsed.meta.name || path.basename(path.dirname(filePath));
  const title = firstMarkdownHeading(parsed.body) || name;
  const description = parsed.meta.description || firstMarkdownParagraph(parsed.body);

  return {
    id: directory,
    name,
    title,
    description,
    source: directory.startsWith(".system") ? "system" : "user",
    path: toClientPath(filePath),
    directory: toClientPath(path.dirname(filePath)),
    updatedAt: stat.mtime.toISOString()
  };
}

async function listSkills() {
  const files = await collectSkillManifests();
  const skills = [];
  for (const filePath of files) {
    try {
      const skill = await readSkillManifest(filePath);
      if (skill) {
        skills.push(skill);
      }
    } catch (_err) {
      continue;
    }
  }

  skills.sort((a, b) => {
    if (a.source !== b.source) {
      return a.source === "system" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return skills;
}

function normalizePromptList(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim()).slice(0, 6);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

async function readPluginManifest(filePath) {
  const stat = await fsp.stat(filePath);
  if (stat.size > MAX_PLUGIN_FILE_BYTES) {
    return null;
  }

  const manifest = JSON.parse(await fsp.readFile(filePath, "utf8"));
  const pluginInterface = manifest.interface && typeof manifest.interface === "object" ? manifest.interface : {};
  const displayName = pluginInterface.displayName || manifest.name || path.basename(path.dirname(path.dirname(filePath)));
  const description = pluginInterface.shortDescription || manifest.description || "";

  return {
    id: manifest.name || path.basename(path.dirname(path.dirname(filePath))),
    name: manifest.name || "",
    displayName,
    version: manifest.version || "",
    description,
    longDescription: pluginInterface.longDescription || description,
    developerName: pluginInterface.developerName || (manifest.author && manifest.author.name) || "",
    category: pluginInterface.category || "",
    capabilities: Array.isArray(pluginInterface.capabilities) ? pluginInterface.capabilities : [],
    defaultPrompt: normalizePromptList(pluginInterface.defaultPrompt),
    homepage: manifest.homepage || pluginInterface.websiteURL || "",
    path: toClientPath(filePath),
    directory: toClientPath(path.dirname(path.dirname(filePath))),
    updatedAt: stat.mtime.toISOString()
  };
}

async function listPlugins() {
  let entries;
  try {
    entries = await fsp.readdir(CODEX_PLUGINS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const plugins = [];
  for (const entry of entries.slice(0, MAX_CATALOG_ITEMS)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(CODEX_PLUGINS_DIR, entry.name, ".codex-plugin", "plugin.json");
    try {
      const plugin = await readPluginManifest(manifestPath);
      if (plugin) {
        plugins.push(plugin);
      }
    } catch (_err) {
      continue;
    }
  }

  plugins.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return plugins;
}

async function handleApi(req, res, requestUrl) {
  try {
    if (req.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        root: ROOT_DIR,
        codexBin: CODEX_BIN,
        pty: Boolean(pty),
        node: process.version,
        platform: process.platform,
        wsPath: "/ws"
      });
      return true;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/projects") {
      sendJson(res, 200, { root: ROOT_DIR, projects: await discoverProjects() });
      return true;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/history") {
      sendJson(res, 200, { root: CODEX_HOME, sessions: await listHistorySessions() });
      return true;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/history/session") {
      sendJson(res, 200, await readHistorySession(requestUrl.searchParams.get("id")));
      return true;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/skills") {
      sendJson(res, 200, { root: CODEX_SKILLS_DIR, skills: await listSkills() });
      return true;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/plugins") {
      sendJson(res, 200, { root: CODEX_PLUGINS_DIR, plugins: await listPlugins() });
      return true;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/tree") {
      sendJson(res, 200, await listDirectory(requestUrl.searchParams.get("path")));
      return true;
    }

    if (req.method === "GET" && requestUrl.pathname === "/api/file") {
      sendJson(res, 200, await readTextFile(requestUrl.searchParams.get("path")));
      return true;
    }

    if (req.method === "PUT" && requestUrl.pathname === "/api/file") {
      const body = await collectJson(req);
      sendJson(res, 200, await writeTextFile(body.path, body.content));
      return true;
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/upload") {
      const body = await collectJson(req, MAX_UPLOAD_BODY_BYTES + 1024 * 1024);
      sendJson(res, 200, await uploadFiles(body.path, body.files));
      return true;
    }

    return false;
  } catch (err) {
    sendError(res, err.statusCode || 400, err.message);
    return true;
  }
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname.startsWith("/api/")) {
    handleApi(req, res, requestUrl).then((handled) => {
      if (!handled) {
        sendError(res, 404, "API 路由不存在");
      }
    });
    return;
  }

  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname.endsWith("/")) {
    pathname += "index.html";
  }

  const filePath = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403).end("禁止访问");
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("未找到");
      return;
    }

    res.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function startWithPty(ws, session, options) {
  const term = pty.spawn(CODEX_BIN, options.args, {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env
  });

  session.child = term;
  session.mode = "pty";
  session.runKind = options.runKind || "terminal";
  send(ws, {
    type: "started",
    pid: term.pid,
    cwd: options.cwd,
    mode: "pty",
    runKind: session.runKind,
    resumeSessionId: options.resumeSessionId || null,
    model: options.model || ""
  });

  term.onData((data) => send(ws, { type: "stdout", data }));
  term.onExit(({ exitCode, signal }) => {
    session.child = null;
    session.runKind = null;
    send(ws, { type: "exit", code: exitCode, signal: signal || null });
  });
}

function startWithSpawn(ws, session, options) {
  const child = spawn(CODEX_BIN, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });

  session.child = child;
  session.mode = "spawn";
  session.runKind = options.runKind || "terminal";
  send(ws, {
    type: "started",
    pid: child.pid,
    cwd: options.cwd,
    mode: "spawn",
    runKind: session.runKind,
    resumeSessionId: options.resumeSessionId || null,
    model: options.model || ""
  });

  child.stdin.on("error", () => {
    // Fast-exiting commands may close stdin before the prompt is written.
  });
  if (typeof options.stdinData === "string") {
    child.stdin.end(options.stdinData);
  }

  child.stdout.on("data", (chunk) => send(ws, { type: "stdout", data: chunk.toString("utf8") }));
  child.stderr.on("data", (chunk) => send(ws, { type: "stderr", data: chunk.toString("utf8") }));
  child.on("error", (err) => {
    session.child = null;
    session.runKind = null;
    send(ws, { type: "error", message: err.message });
  });
  child.on("close", (code, signal) => {
    session.child = null;
    session.runKind = null;
    send(ws, { type: "exit", code, signal });
  });
}

function stopSession(session, signal = "SIGTERM") {
  if (!session.child) {
    return false;
  }

  if (session.mode === "pty") {
    session.child.kill(signal);
  } else {
    session.child.kill(signal);
  }
  return true;
}

function handleStart(ws, session, message) {
  if (session.child) {
    throw new Error("已有会话正在运行");
  }

  const cwd = normalizeCwd(message.cwd);
  const args = sanitizeArgs(message.args);
  const resumeSessionId = sanitizeSessionId(message.resumeSessionId);
  const model = sanitizeModel(message.model);
  const env = { ...process.env, ...sanitizeEnv(message.env), TERM: "xterm-256color" };
  const cols = Number.isInteger(message.cols) ? message.cols : 120;
  const rows = Number.isInteger(message.rows) ? message.rows : 30;
  const usePty = message.pty === true && pty;
  const options = {
    cwd,
    args: buildCodexArgs(args, resumeSessionId, model),
    env,
    cols,
    rows,
    runKind: "terminal",
    resumeSessionId,
    model
  };

  if (usePty) {
    startWithPty(ws, session, options);
  } else {
    startWithSpawn(ws, session, options);
  }
}

function handlePrompt(ws, session, message) {
  if (session.child) {
    throw new Error("已有任务正在运行");
  }

  const prompt = sanitizePrompt(message.prompt);
  if (!prompt.trim()) {
    throw new Error("提示内容不能为空");
  }

  const cwd = normalizeCwd(message.cwd);
  const args = sanitizeArgs(message.args);
  const resumeSessionId = sanitizeSessionId(message.resumeSessionId);
  const model = sanitizeModel(message.model);
  const env = { ...process.env, ...sanitizeEnv(message.env), TERM: "xterm-256color" };
  const options = {
    cwd,
    args: buildExecArgs(args, resumeSessionId, model),
    env,
    cols: 120,
    rows: 30,
    runKind: "chat",
    resumeSessionId,
    model,
    stdinData: prompt.endsWith("\n") ? prompt : `${prompt}\n`
  };

  startWithSpawn(ws, session, options);
}

function handleMessage(ws, session, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch (_err) {
    throw new Error("消息必须是 JSON");
  }

  switch (message.type) {
    case "prompt":
      handlePrompt(ws, session, message);
      break;
    case "start":
      handleStart(ws, session, message);
      break;
    case "stdin":
      if (!session.child) {
        throw new Error("没有正在运行的会话");
      }
      if (session.mode === "pty") {
        session.child.write(String(message.data || ""));
      } else {
        session.child.stdin.write(String(message.data || ""));
      }
      break;
    case "resize":
      if (session.child && session.mode === "pty" && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
        session.child.resize(message.cols, message.rows);
      }
      break;
    case "stop":
      stopSession(session, message.signal || "SIGTERM");
      break;
    default:
      throw new Error(`未知消息类型：${message.type}`);
  }
}

const server = http.createServer(serveStatic);
const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const session = { child: null, mode: null };
  send(ws, { type: "ready", cwd: ROOT_DIR, pty: Boolean(pty) });

  ws.on("message", (raw) => {
    try {
      handleMessage(ws, session, raw);
    } catch (err) {
      send(ws, { type: "error", message: err.message });
    }
  });

  ws.on("close", () => {
    stopSession(session);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`codex-web 服务已启动：http://${HOST}:${PORT}`);
  console.log(`静态文件目录：${PUBLIC_DIR}`);
});
