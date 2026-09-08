import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp"
};

function healthPayload() {
  return JSON.stringify({
    data: {
      status: "ok",
      version: "design-preview",
      searchConfigured: false,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }
  });
}

function safePath(requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }

  const relative = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.resolve(root, `.${relative}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }
  return candidate;
}

async function findFile(requestPath) {
  const candidate = safePath(requestPath);
  if (!candidate) return null;

  const candidates = [candidate];
  if (!path.extname(candidate)) candidates.push(`${candidate}.html`);

  for (const filePath of candidates) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) return filePath;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  if (requestUrl.pathname === "/api/v1/health") {
    const body = healthPayload();
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body)
    });
    if (request.method !== "HEAD") response.end(body);
    else response.end();
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }

  const filePath = await findFile(requestUrl.pathname);
  if (!filePath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const body = await fs.readFile(filePath);
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-length": body.length,
    "content-type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream"
  });
  if (request.method !== "HEAD") response.end(body);
  else response.end();
});

server.listen(port, "0.0.0.0", () => {
  console.log(`design-preview listening on ${port}`);
});
