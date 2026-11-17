// Shared stand-ins for the control route specs (gaulatti/alcantara#194). Kept
// outside app/ so they are not part of the coverage denominator.
import { vi } from "vitest";

export type Answer = Response | (() => Response | Promise<Response>);

export interface ControlServer {
  calls: { method: string; path: string; body: unknown }[];
  answers: Map<string, Answer>;
  /** Set or replace the answer for `METHOD /path` (query string included). */
  answer(key: string, value: Answer): void;
  /** Requests for one `METHOD /path`, in order. */
  requests(key: string): unknown[];
}

/**
 * One fetch stand-in for every request the console makes, keyed by
 * `METHOD /path?query`. Unknown requests answer 404, so a missing fixture shows
 * up as a refused request instead of a thrown test.
 */
export function controlServer(defaults: Record<string, Answer>): ControlServer {
  const calls: ControlServer["calls"] = [];
  const answers = new Map<string, Answer>(Object.entries(defaults));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = (init?.method ?? "GET").toUpperCase();
      const path = decodeURIComponent(url.pathname) + url.search;
      let body: unknown = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ method, path, body });
      const answer = answers.get(`${method} ${path}`);
      if (!answer) return new Response("not found", { status: 404 });
      return typeof answer === "function" ? answer() : answer.clone();
    }),
  );
  return {
    calls,
    answers,
    answer(key, value) {
      answers.set(key, value);
    },
    requests(key) {
      return calls
        .filter((call) => `${call.method} ${call.path}` === key)
        .map((call) => call.body);
    },
  };
}

/** Browser APIs jsdom lacks that the console's panels use while mounting. */
export function stubConsoleBrowser() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
}

/** A WebSocket stand-in the test opens, feeds and closes. */
export class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  closed = false;
  listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, event: unknown = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }
  send(payload: unknown) {
    this.emit("message", {
      data: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}
