import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClient, ApiError, HELPER_VERSION, TokenRevoked } from "../src/api.ts";

const TOKEN = "hlp_" + "t".repeat(43);
interface Seen { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A fetch that records each request and answers with the next scripted response. */
function fake(...responses: (Response | Error)[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown = init?.body;
    if (body instanceof Uint8Array) body = Buffer.from(body);
    seen.push({ url: String(input), method: init?.method ?? "GET", headers, body });
    const r = responses.shift();
    if (!r) throw new Error("no more scripted responses");
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  const slept: number[] = [];
  const client = new ApiClient({ apiBase: "https://agency.example.com", token: TOKEN }, fetchImpl, { sleep: async (ms) => { slept.push(ms); }, backoffMs: (n) => n });
  return { seen, slept, client };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "helper-api-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ApiClient", () => {
  it("hello posts to /helper/hello with the bearer token", async () => {
    const { seen, client } = fake(json({ serverTime: "2026-11-18T00:00:00.000Z", minHelperVersion: "0.1.0" }));
    const r = await client.hello();
    expect(r).toEqual({ serverTime: "2026-11-18T00:00:00.000Z", minHelperVersion: "0.1.0" });
    expect(seen[0].url).toBe("https://agency.example.com/helper/hello");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("claim sends the kinds and returns the job with its input and output lists", async () => {
    const job = { id: "j1", kind: "voice.segment", attempts: 1, payload: { videoId: "v" }, inputs: ["voice-reference/reference.m4a"], outputs: ["video/v/audio/s-abc.wav"] };
    const { seen, client } = fake(json({ job }));
    expect(await client.claim(["voice.segment", "voice.sample"])).toEqual(job);
    expect(seen[0].url).toBe("https://agency.example.com/helper/jobs/claim");
    expect(JSON.parse(String(seen[0].body))).toEqual({ kinds: ["voice.segment", "voice.sample"] });
  });

  it("claim returns null when nothing is waiting", async () => {
    const { client } = fake(json({}));
    expect(await client.claim(["voice.segment"])).toBeNull();
  });

  it("claim refuses a job the server sent in a shape it does not understand", async () => {
    const { client } = fake(json({ job: { id: "j1" } }));
    await expect(client.claim(["voice.segment"])).rejects.toThrow(/unexpected job/);
  });

  it("a 401 throws TokenRevoked on every call, with a message that never holds the token", async () => {
    const unauth = () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    const f = fake(unauth(), unauth(), unauth(), unauth(), unauth(), unauth());
    const file = join(dir, "x.wav"); writeFileSync(file, "x");
    const calls = [
      () => f.client.hello(), () => f.client.claim([]), () => f.client.download("j", "k", join(dir, "o")),
      () => f.client.upload("j", "k", file, "audio/wav"), () => f.client.complete("j", {}), () => f.client.fail("j", "e"),
    ];
    for (const c of calls) {
      const e = await c().then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(TokenRevoked);
      expect((e as Error).message).toMatch(/revoked/i);
      expect((e as Error).message).not.toContain(TOKEN);
    }
  });

  it("download streams the input to a file and puts the key in the query", async () => {
    const { seen, client } = fake(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const to = join(dir, "ref.m4a");
    await client.download("job 1", "voice-reference/reference file.m4a", to);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toBe("https://agency.example.com/helper/jobs/job%201/input?key=voice-reference%2Freference%20file.m4a");
    expect([...readFileSync(to)]).toEqual([1, 2, 3, 4]);
  });

  it("download reports the server's reason when the file is refused", async () => {
    const { client } = fake(json({ error: "that file is not an input of this job" }, 403));
    const e = await client.download("j", "k", join(dir, "o")).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(403);
    expect((e as Error).message).toMatch(/not an input/);
  });

  it("upload PUTs the file bytes with its content type to the output key", async () => {
    const { seen, client } = fake(json({ ok: true, bytes: 5 }));
    const file = join(dir, "out.wav"); writeFileSync(file, "RIFF!");
    await client.upload("j1", "video/v/audio/s-abc.wav", file, "audio/wav");
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toBe("https://agency.example.com/helper/jobs/j1/output?key=video%2Fv%2Faudio%2Fs-abc.wav");
    expect(seen[0].headers["content-type"]).toBe("audio/wav");
    expect(String(seen[0].body)).toBe("RIFF!");
  });

  it("a 413 says how big an upload may be, from the server's own words", async () => {
    const { client } = fake(json({ error: "An upload may be at most 80 MB" }, 413));
    const file = join(dir, "big.mp4"); writeFileSync(file, "x");
    const e = await client.upload("j", "k", file, "video/mp4").then(() => null, (x: unknown) => x);
    expect((e as ApiError).status).toBe(413);
    expect((e as Error).message).toMatch(/80 MB/);
  });

  it("complete posts the result, and a 409 is an ApiError the loop can tell apart", async () => {
    const f = fake(json({ ok: true }), json({ error: "already done" }, 409));
    await f.client.complete("j1", { key: "k", durationMs: 1200 });
    expect(f.seen[0].url).toBe("https://agency.example.com/helper/jobs/j1/complete");
    expect(JSON.parse(String(f.seen[0].body))).toEqual({ result: { key: "k", durationMs: 1200 } });
    const e = await f.client.complete("j1", {}).then(() => null, (x: unknown) => x);
    expect((e as ApiError).status).toBe(409);
  });

  it("fail posts the error text", async () => {
    const { seen, client } = fake(json({ ok: true }));
    await client.fail("j1", "the engine fell over");
    expect(seen[0].url).toBe("https://agency.example.com/helper/jobs/j1/fail");
    expect(JSON.parse(String(seen[0].body))).toEqual({ error: "the engine fell over" });
  });

  it("touch posts to /touch, and a 409 throws so the handler stops", async () => {
    const f = fake(new Response(null, { status: 204 }), json({ error: "this job is not claimed by this device" }, 409));
    await f.client.touch("j1");
    expect(f.seen[0].url).toBe("https://agency.example.com/helper/jobs/j1/touch");
    expect(f.seen[0].method).toBe("POST");
    const e = await f.client.touch("j1").then(() => null, (x: unknown) => x);
    expect((e as ApiError).status).toBe(409);
    expect(f.seen).toHaveLength(2);
  });

  it("touch tries again on a transient failure", async () => {
    const f = fake(new Response("x", { status: 503 }), new Response(null, { status: 204 }));
    await f.client.touch("j1");
    expect(f.seen).toHaveLength(2);
  });

  it("an answer that is not JSON still gives a readable error", async () => {
    const { client } = fake(new Response("<html>bad gateway</html>", { status: 502 }));
    const e = await client.hello().then(() => null, (x: unknown) => x);
    expect((e as ApiError).status).toBe(502);
    expect((e as Error).message).toMatch(/502/);
  });

  it("the helper version matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(HELPER_VERSION).toBe(pkg.version);
  });

  describe("retries", () => {
    it("download retries a network blip and succeeds", async () => {
      const f = fake(new TypeError("fetch failed"), new Response(new Uint8Array([9, 8]), { status: 200 }));
      const to = join(dir, "ref.m4a");
      await f.client.download("j", "k", to);
      expect(f.seen.length).toBe(2);
      expect(f.slept).toEqual([1]);
      expect([...readFileSync(to)]).toEqual([9, 8]);
    });

    it("upload retries a 503 then succeeds", async () => {
      const f = fake(json({ error: "busy" }, 503), json({ ok: true, bytes: 5 }));
      const file = join(dir, "o.wav"); writeFileSync(file, "RIFF!");
      await f.client.upload("j", "k", file, "audio/wav");
      expect(f.seen.length).toBe(2);
      expect(String(f.seen[1].body)).toBe("RIFF!");
    });

    it("upload retries a 429 too", async () => {
      const f = fake(json({ error: "slow down" }, 429), json({ ok: true }));
      const file = join(dir, "o.wav"); writeFileSync(file, "x");
      await f.client.upload("j", "k", file, "audio/wav");
      expect(f.seen.length).toBe(2);
    });

    it("upload does not retry a 413", async () => {
      const f = fake(json({ error: "An upload may be at most 80 MB" }, 413), json({ ok: true }));
      const file = join(dir, "big.mp4"); writeFileSync(file, "x");
      await expect(f.client.upload("j", "k", file, "video/mp4")).rejects.toMatchObject({ status: 413 });
      expect(f.seen.length).toBe(1);
      expect(f.slept).toEqual([]);
    });

    it("download does not retry a 403 or 404", async () => {
      for (const status of [403, 404]) {
        const f = fake(json({ error: "no" }, status), new Response("late", { status: 200 }));
        await expect(f.client.download("j", "k", join(dir, "o"))).rejects.toMatchObject({ status });
        expect(f.seen.length).toBe(1);
      }
    });

    it("a 401 on download is not retried", async () => {
      const f = fake(new Response("{}", { status: 401 }), new Response("late", { status: 200 }));
      await expect(f.client.download("j", "k", join(dir, "o"))).rejects.toBeInstanceOf(TokenRevoked);
      expect(f.seen.length).toBe(1);
      expect(f.slept).toEqual([]);
    });

    it("a 401 on upload is not retried", async () => {
      const f = fake(new Response("{}", { status: 401 }));
      const file = join(dir, "o.wav"); writeFileSync(file, "x");
      await expect(f.client.upload("j", "k", file, "audio/wav")).rejects.toBeInstanceOf(TokenRevoked);
      expect(f.seen.length).toBe(1);
    });

    it("gives up after 3 attempts with the last error", async () => {
      const f = fake(new TypeError("fetch failed 1"), json({ error: "busy 2" }, 503), json({ error: "busy 3" }, 502), json({ ok: true }));
      const file = join(dir, "o.wav"); writeFileSync(file, "x");
      const e = await f.client.upload("j", "k", file, "audio/wav").then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(502);
      expect((e as Error).message).toBe("busy 3");
      expect(f.seen.length).toBe(3);
      expect(f.slept).toEqual([1, 2]);
    });
  });
});
