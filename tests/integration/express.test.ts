import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createStateReplayMiddleware } from "../../src/express/index.js";
import { createStateReplay } from "../../src/index.js";
import { createTempStorage, removeTempStorage } from "../helpers/tempDir.js";

const tmpDirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await createTempStorage();
  tmpDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => removeTempStorage(d)));
});

function startServer(
  app: ReturnType<typeof express>,
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, close: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}

describe("integration: express middleware", { timeout: 30_000 }, () => {
  it("serves health, states, states/:id (+404), and the dashboard", async () => {
    const replay = await createStateReplay({
      storagePath: await tmp(),
      lock: false,
      durability: "none",
    });
    await replay.setState("job-1", { step: "INIT", status: "PROCESSING", data: { n: 1 } });
    await replay.setState("job-2", { step: "DONE", status: "SUCCESS" });

    const app = express();
    app.use(createStateReplayMiddleware(replay));
    const { port, close } = await startServer(app);
    const base = `http://127.0.0.1:${port}/_statereplay`;

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.ready).toBe(true);
    expect(health.eventCount).toBe(2);
    expect(health.idCount).toBe(2);

    const states = await fetch(`${base}/states`).then((r) => r.json());
    expect(Object.keys(states.states).sort()).toEqual(["job-1", "job-2"]);
    expect(states.states["job-1"].status).toBe("PROCESSING");

    const one = await fetch(`${base}/states/job-1`).then((r) => r.json());
    expect(one.id).toBe("job-1");
    expect(one.state.step).toBe("INIT");

    const missing = await fetch(`${base}/states/does-not-exist`);
    expect(missing.status).toBe(404);

    const dash = await fetch(`${base}/dashboard`);
    expect(dash.status).toBe(200);
    expect(dash.headers.get("content-type")).toContain("text/html");
    expect(await dash.text()).toContain("StateReplay");

    // An unrelated path falls through to Express (default 404).
    const other = await fetch(`http://127.0.0.1:${port}/something-else`);
    expect(other.status).toBe(404);

    await close();
    await replay.close();
  });

  it("returns 404 for the dashboard when disabled", async () => {
    const replay = await createStateReplay({
      storagePath: await tmp(),
      lock: false,
      durability: "none",
    });
    const app = express();
    app.use(createStateReplayMiddleware(replay, { enableDashboard: false }));
    const { port, close } = await startServer(app);

    const dash = await fetch(`http://127.0.0.1:${port}/_statereplay/dashboard`);
    expect(dash.status).toBe(404);
    // Other endpoints still work.
    const health = await fetch(`http://127.0.0.1:${port}/_statereplay/health`).then((r) =>
      r.json(),
    );
    expect(health.ok).toBe(true);

    await close();
    await replay.close();
  });

  it("honours a custom basePath", async () => {
    const replay = await createStateReplay({
      storagePath: await tmp(),
      lock: false,
      durability: "none",
    });
    await replay.setState("a", { step: "S", status: "PENDING" });
    const app = express();
    app.use(createStateReplayMiddleware(replay, { basePath: "/_admin/sr" }));
    const { port, close } = await startServer(app);

    const health = await fetch(`http://127.0.0.1:${port}/_admin/sr/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    // The default basePath is no longer mounted.
    const def = await fetch(`http://127.0.0.1:${port}/_statereplay/health`);
    expect(def.status).toBe(404);

    await close();
    await replay.close();
  });
});
