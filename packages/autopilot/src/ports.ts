// A pool of local ports for the replay servers and app servers of one matrix (plan §6.3).
import { createServer } from "node:net";
import type { PortPool } from "./types.js";

const DEFAULT_RANGE: [number, number] = [43100, 43999];

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/** Hands out ports in `[start, end]` that are free on 127.0.0.1 and not already out. */
export function createPortPool(range: [number, number] = DEFAULT_RANGE): PortPool {
  const [start, end] = range;
  const out = new Set<number>();
  let next = start;
  return {
    async acquire() {
      for (let tried = 0; tried <= end - start; tried++) {
        const port = next;
        next = next >= end ? start : next + 1;
        if (out.has(port)) continue;
        out.add(port);
        if (await isFree(port)) return port;
        out.delete(port);
      }
      throw new Error(`no free port between ${start} and ${end}`);
    },
    release(port) {
      out.delete(port);
    },
  };
}
