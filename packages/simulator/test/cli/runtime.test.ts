import { describe, expect, it } from "vitest";
import { retryStaleSocket } from "../../cli/runtime.js";

/** undici's error for a kept-alive connection the other side closed: TypeError("fetch failed") with that cause. */
const staleSocket = () =>
  Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });

describe("requests to the local workerd", () => {
  it("are sent once more when the kept-alive connection had gone stale", async () => {
    let calls = 0;
    const answer = await retryStaleSocket(async () => {
      calls += 1;
      if (calls === 1) throw staleSocket();
      return "ok";
    });
    expect(answer).toBe("ok");
    expect(calls).toBe(2);
  });

  it("are not retried for any other failure, nor more than once", async () => {
    let calls = 0;
    const other = new TypeError("fetch failed", {
      cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
    });
    await expect(
      retryStaleSocket(async () => {
        calls += 1;
        throw other;
      }),
    ).rejects.toBe(other);
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      retryStaleSocket(async () => {
        calls += 1;
        throw staleSocket();
      }),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(2);
  });
});
