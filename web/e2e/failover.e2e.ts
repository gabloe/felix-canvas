import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { EMPTY_DOC, apply, decodeOp, stateHash, type Op } from "@felix-canvas/model";
import { expect, test, type Page } from "@playwright/test";

import { hashes, join, leaveAll, read, readLog, settle } from "./helpers";

// Runs against the three-broker stack only: `dev/up.sh --cluster`, with the
// gateway and snapshotter given all three brokers.
test.skip(!process.env.CANVAS_FELIX_CLUSTER, "needs dev/up.sh --cluster");
test.afterEach(leaveAll);

const CONTROL_PLANE = "http://127.0.0.1:8443";
const SNAPSHOTTER = "http://127.0.0.1:8788/";
const STATE = new URL("../../dev/state/", import.meta.url);

/** The broker that owns `stream`'s one shard, as the control plane has it placed. */
async function owner(stream: string): Promise<string> {
  const token = readFileSync(new URL("node.token", STATE), "utf8").trim();
  const response = await fetch(`${CONTROL_PLANE}/v1/placement/replication`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { items } = (await response.json()) as {
    items: { stream: string; kind: string; leader: string | null }[];
  };
  const shard = items.find((item) => item.kind === "stream" && item.stream === stream);
  if (!shard?.leader) throw new Error(`${stream} has no owner`);
  return shard.leader;
}

/**
 * Shards short of their copies, being given one, or without a leader. Losing a
 * broker while any is listed can leave that shard without a majority.
 */
async function unreplicated(): Promise<string[]> {
  const token = readFileSync(new URL("node.token", STATE), "utf8").trim();
  const response = await fetch(`${CONTROL_PLANE}/v1/placement/replication`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const { items } = (await response.json()) as {
    items: {
      kind: string;
      stream: string;
      leader: string | null;
      under_replicated: boolean;
      restoring?: string;
      unavailable?: string[];
    }[];
  };
  return items
    .filter((i) => !i.leader || i.under_replicated || i.restoring || i.unavailable?.length)
    .map((i) => `${i.kind} ${i.stream}`);
}

/** The engine `dev/up.sh` picks: CONTAINER_ENGINE, else Docker if it answers, else Podman. */
function containerEngine(): string {
  if (process.env.CONTAINER_ENGINE) return process.env.CONTAINER_ENGINE;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return "docker";
  } catch {
    return "podman";
  }
}

/** The container docker-compose.cluster.yml runs broker `node` in. */
function container(node: string): string {
  return node === "broker-1" ? "felix-canvas-broker-1" : `felix-canvas-${node}-1`;
}

const opKey = (op: Op) => `${op.sid}:${op.seq}`;

/** Record when each of the page's ops was acknowledged, read off its gateway socket. */
function trackAcks(acked: Map<string, number>) {
  return (page: Page) =>
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname !== "/ws") return;
      const sent = new Map<number, string>();
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "publish" && message.stream === "ops") {
          sent.set(message.id, opKey(decodeOp(Buffer.from(message.payload, "base64"))));
        }
      });
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        const key = message.type === "ack" ? sent.get(message.id) : undefined;
        if (key && !acked.has(key)) acked.set(key, Date.now());
      });
    });
}

async function drawRectangle(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.press("r");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 80, { steps: 8 });
  await page.mouse.up();
}

test("editing carries on when the broker that owns the room is killed", async ({ browser }) => {
  test.setTimeout(300_000);
  const acked = new Map<string, number>();
  const ana = await join(browser, "Ana", trackAcks(acked));
  const ben = await join(browser, "Ben", trackAcks(acked));
  // Cleo watches the room's history the whole time, over its own connection.
  const cleo = await join(browser, "Cleo");
  await cleo.getByRole("button", { name: "History" }).click();
  await expect.poll(() => cleo.evaluate(() => window.felixCanvas.history.ready())).toBe(true);
  await drawRectangle(ana, 300, 300);
  await drawRectangle(ben, 700, 300);
  await settle([ana, ben]);

  // Each nudges its own rectangle every 25 ms until told to stop: a steady
  // stream of edits, some of them in flight when the broker dies.
  let editing = true;
  const nudging = [ana, ben].map(async (page) => {
    for (let i = 0; editing; i++) {
      await page.keyboard.press(i % 2 ? "ArrowDown" : "ArrowRight");
      await page.waitForTimeout(25);
    }
  });

  await ana.waitForTimeout(2000);
  await expect.poll(unreplicated, { timeout: 60_000 }).toEqual([]);
  const engine = containerEngine();
  const killed = await owner("canvas.ops.lobby");
  const killedAt = Date.now();
  execFileSync(engine, ["kill", container(killed)]);
  try {
    await test.step("another broker takes the room and edits are acknowledged again", async () => {
      await expect.poll(() => owner("canvas.ops.lobby"), { timeout: 60_000 }).not.toBe(killed);
      await expect
        .poll(() => [...acked.values()].filter((at) => at > killedAt).length, { timeout: 60_000 })
        .toBeGreaterThan(20);
      const times = [...acked.values()].filter((at) => at > killedAt - 1000).sort((a, b) => a - b);
      const pause = Math.max(...times.slice(1).map((at, i) => at - times[i]!));
      console.log(`${killed} killed; the longest wait between acknowledged edits was ${pause} ms`);
      await ana.waitForTimeout(2000);
      editing = false;
      await Promise.all(nudging);
    });

    await test.step("both browsers end in the state the log holds, with every acknowledged edit", async () => {
      await settle([ana, ben], 60_000);
      const [first, second] = await hashes([ana, ben]);
      expect(second).toBe(first);

      const records = await readLog((await read(ana)).applied);
      let doc = EMPTY_DOC;
      const landed = new Map<string, number>();
      for (const [offset, payload] of records) {
        let op: Op;
        try {
          op = decodeOp(payload);
        } catch {
          continue;
        }
        doc = apply(doc, op, offset);
        landed.set(opKey(op), (landed.get(opKey(op)) ?? 0) + 1);
      }
      expect(stateHash(doc)).toBe(first);
      const lost = [...acked.keys()].filter((key) => !landed.has(key));
      expect(lost).toEqual([]);
      const doubles = [...landed.values()].filter((count) => count > 1).length;
      console.log(`${acked.size} edits acknowledged, ${doubles} landed twice and were absorbed`);
    });

    await test.step("the history view kept up through it", async () => {
      const { applied, hash } = await read(ana);
      await expect
        .poll(() => cleo.evaluate(() => window.felixCanvas.history.end()), { timeout: 60_000 })
        .toBe(applied);
      expect(await cleo.evaluate((end) => window.felixCanvas.history.freshHash(end), applied)).toBe(
        hash,
      );
    });

    await test.step("the snapshotter carried on folding the log", async () => {
      const { applied } = await read(ana);
      await expect
        .poll(
          async () =>
            ((await (await fetch(SNAPSHOTTER)).json()) as { lobby: { applied: number } }).lobby
              .applied,
          // Long enough for it to wait out its claims after reconnecting.
          { timeout: 90_000 },
        )
        .toBe(applied - 1);
    });

    await test.step("a browser that joins afterwards reaches the same state", async () => {
      const dan = await join(browser);
      await settle([ana, ben, dan], 60_000);
      expect(new Set(await hashes([ana, ben, dan])).size).toBe(1);
    });
  } finally {
    editing = false;
    execFileSync(engine, ["start", container(killed)]);
  }
});
