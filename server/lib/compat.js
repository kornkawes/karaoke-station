import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";

const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

if (typeof Object.hasOwn !== "function") {
  Object.defineProperty(Object, "hasOwn", {
    configurable: true,
    writable: true,
    value(object, property) {
      return Object.prototype.hasOwnProperty.call(object, property);
    }
  });
}

export function cloneJson(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function randomUuid() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-");
}

export function toBase64Url(value) {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

export function createAbortController() {
  if (typeof globalThis.AbortController === "function") {
    return new globalThis.AbortController();
  }

  const listeners = new Set();
  const signal = {
    aborted: false,
    addEventListener(eventName, listener) {
      if (eventName === "abort" && typeof listener === "function") listeners.add(listener);
    },
    removeEventListener(eventName, listener) {
      if (eventName === "abort") listeners.delete(listener);
    }
  };
  return {
    signal,
    abort() {
      if (signal.aborted) return;
      signal.aborted = true;
      for (const listener of listeners) listener();
      listeners.clear();
    }
  };
}

export function legacyFetch(input, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = input instanceof URL ? input : new URL(String(input));
    } catch {
      reject(new TypeError("Invalid URL"));
      return;
    }
    if (url.protocol !== "https:") {
      reject(new TypeError("Legacy fetch only allows HTTPS"));
      return;
    }
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      operation();
    };
    const request = httpsRequest(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
        ...headers
      }
    }, (response) => {
      const chunks = [];
      let totalBytes = 0;
      response.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > DEFAULT_MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Response body exceeds compatibility limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("error", (error) => finish(() => reject(error)));
      response.once("end", () => finish(() => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode || 0,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          async json() {
            return JSON.parse(body);
          }
        });
      }));
    });
    const onAbort = () => request.destroy(abortError());
    signal?.addEventListener?.("abort", onAbort);
    request.once("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

export function defaultFetch() {
  return typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : legacyFetch;
}
