// A pen-menu command that talks to the page through the bridge, for the
// end-to-end tests. CommonJS, Node >= 20, no dependencies. Usage:
//   node bridge-tool.cjs selection | ask | draw | buttons | watch
"use strict";
const net = require("node:net");

const sock = net.connect(process.env.PDFINK_SOCKET);
const pending = new Map();
const listeners = [];
let nextId = 1;
let buf = "";

sock.setEncoding("utf8");
sock.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if ("error" in msg) reject(new Error(msg.error));
      else resolve(msg.result);
    } else if (msg.event !== undefined) {
      for (const fn of listeners) fn(msg.event, msg.data);
    }
  }
});
sock.on("error", (err) => {
  console.error(`bridge: ${err.message}`);
  process.exit(1);
});

function send(obj) {
  sock.write(JSON.stringify(obj) + "\n");
}

/** Call a window.pdfink method; resolves with its result. */
function call(name, ...args) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, call: name, args });
  });
}

/** Subscribe to page events; `fn(event, data)` gets each one. */
function events(names, fn) {
  listeners.push(fn);
  send({ subscribe: names });
}

const toast = (message) => call("toast", message);

const commands = {
  async selection() {
    const s = await call("selection");
    if (!s) return toast("nothing selected");
    const png = await call("selectionPng");
    await toast(`${s.strokeIds.length} strokes ${Math.round(s.rect.w)}x${Math.round(s.rect.h)} png ${png.length}`);
  },
  async ask() {
    const name = await call("ask", "Your name?", { default: "Ada" });
    await toast(`hello ${name}`);
  },
  async draw() {
    const dx = Number(process.env.DX);
    const dy = Number(process.env.DY);
    const points = [{ x: dx - 40, y: dy, p: 0.5 }, { x: dx + 40, y: dy, p: 0.5 }];
    await call("addStrokes", Number(process.env.PAGE) - 1, [{ color: "#ff0000", width: 2, opacity: 1, points }]);
    console.log("drew");
  },
  async buttons() {
    await call("addButton", "hello", "Say hello");
    await call("addButton", "bye", "Finish", { where: "toolbar" });
    await new Promise((resolve) => {
      events(["button"], (event, data) => {
        if (event === "button" && data && data.id === "hello") void toast("hello pressed");
        if ((event === "button" && data && data.id === "bye") || event === "exit" || event === "gone") resolve();
      });
    });
  },
  // Detached: waits for the first ink event, then labels that page's text
  // quietly and finishes, like a tiny ocr-page.py --watch.
  async watch() {
    await new Promise((resolve, reject) => {
      events(["ink", "page"], (event, data) => {
        if (event === "exit" || event === "gone") return resolve();
        if (event !== "ink") return;
        const text = `watched page ${data.page + 1}`;
        call("setInkText", data.page, [{ text, x: 20, y: 20, w: 100, h: 12 }], { quiet: true })
          .then(() => toast(text))
          .then(resolve, reject);
      });
    });
  },
};

const run = commands[process.argv[2]];
if (!run) {
  console.error(`unknown subcommand ${process.argv[2]}`);
  process.exit(2);
}
run().then(
  () => {
    sock.end();
    process.exit(0);
  },
  (err) => {
    console.error(err.message);
    process.exit(1);
  },
);
