import net from "net";
import { execSync, spawn } from "child_process";

// The stock chrome-cdp CLI can't find Chrome. We drive CDP directly:
// 1) launch Chrome headless with remote debugging,
// 2) load the dashboard,
// 3) grab dimensions + screenshot + perf counters across a ~14s window
//    (≈3 poll cycles), to verify no unbounded growth.

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:8080";
const PORT = 9333;

function killChrome() {
  try { execSync('taskkill /F /IM chrome.exe', { stdio: "ignore" }); } catch {}
}

async function waitPort(port, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await new Promise((res) => {
      const s = net.createConnection(port, "127.0.0.1");
      s.on("connect", () => { s.end(); res(true); });
      s.on("error", () => res(false));
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  return r.json();
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null) pending.get(msg.id)?.(msg);
  });
  function send(method, params = {}) {
    id++;
    return new Promise((res) => {
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return { ws, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  killChrome();
  await sleep(500);

  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--no-first-run",
    "--disable-gpu",
    "--user-data-dir=" + process.env.TEMP + "\\chrome-cdp-profile",
    URL
  ], { stdio: "ignore" });

  const up = await waitPort(PORT);
  if (!up) throw new Error("chrome did not open its debug port");

  let targets = [];
  for (let i = 0; i < 20; i++) {
    targets = await listTargets(PORT);
    if (targets.some((t) => t.url.includes("localhost:8080"))) break;
    await sleep(300);
  }
  const page = targets.find((t) => t.url.includes("localhost:8080") && t.type === "page");
  if (!page) throw new Error("no page target for localhost:8080 in " + JSON.stringify(targets));

  const { send, ws } = await connect(page.webSocketDebuggerUrl);
  await send("Page.enable");
  await send("Runtime.enable");
  await sleep(1500); // let React hydrate + first paint

  const evalExpr = async (expr) => {
    const r = await send("Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true
    });
    return r.result?.result?.value;
  };

  const snap = () => evalExpr(`JSON.stringify({
    kpiCount: document.querySelectorAll('.kpi').length,
    sectionH: [...document.querySelectorAll('.section')].map(s => s.scrollHeight),
    gridH: [...document.querySelectorAll('.grid-2')].map(g => g.scrollHeight),
    bodyH: document.body.scrollHeight,
    rootH: document.getElementById('root').scrollHeight,
    canvases: document.querySelectorAll('canvas, svg').length,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    ts: Date.now()
  })`);

  const shots = [];
  for (const [label, wait] of [["t+1.5s", 0], ["t+7s", 5500], ["t+14s", 7000]]) {
    if (wait) await sleep(wait);
    const raw = await snap();
    const m = JSON.parse(raw);
    console.log(`\n[${label}] body=${m.bodyH}px root=${m.rootH}px sections=[${m.sectionH}] grid=[${m.gridH}] canvases=${m.canvases} heap=${m.heapMB}MB`);
    shots.push(m);
  }

  // screenshot for visual sanity
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(shot.result.data, "base64");
  const { writeFileSync } = await import("fs");
  writeFileSync("dashboard.png", buf);
  console.log(`\nwrote dashboard.png (${buf.length} bytes)`);

  const growth = shots[2].rootH - shots[0].rootH;
  const heapGrowth = (shots[2].heapMB ?? 0) - (shots[0].heapMB ?? 0);
  console.log(`\nroot height delta after 3 polls: ${growth}px (should be 0)`);
  console.log(`heap delta: ${heapGrowth}MB (should be small)`);
  if (growth > 4) throw new Error(`UI grew by ${growth}px — layout loop still present`);

  ws.close();
  chrome.kill();
}

main().catch((e) => { console.error("TEST FAILED:", e); process.exit(1); });
