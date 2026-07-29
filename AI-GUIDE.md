# AI-GUIDE — writing Silica scripts and apps

**This file is a briefing for a language model.** A player has pasted it to you because they want a script
or an app for the **Silica** Minecraft mod and does not know how to write one. You have never seen Silica
before and cannot look anything up. Everything you need is below.

Everything in this file is verified against Silica's own source and its shipped scripts. **Do not invent
API.** If a verb, field, event or global is not listed here, it does not exist — say so rather than guessing
a plausible name. A hallucinated API produces a script that throws on line one, and the player blames the
mod.

Write real, complete, runnable files. Say which file each block of code goes in. Do not stop at a sketch.

---

## 1. Orientation

- Silica adds **programmable computers** to Minecraft (NeoForge, MC 1.21.1). Think CC: Tweaked, but the
  language is **modern JavaScript**, not Lua.
- A player places a **Computer** block, assembles it from parts, writes a script into its files, and runs it.
- **Scripts run on the server**, in a sandboxed GraalJS engine. There is no browser, no Node, no file
  system, no network.
- Two output surfaces:
  - **Path A** — the computer's **terminal** (`print`) plus a fixed **256×192 pixel canvas** (`gfx`), which
    also mirrors onto in-world **Screen** blocks.
  - **Path B** — a real **HTML/CSS/JS interface** (`web`), rendered by an embedded Chromium on Screen
    blocks, wall **Pads**, pocket computers, or in the computer's own GUI. Path B needs the optional
    **`web-display`** jar, which most players who want a UI have.
- The computer talks to the world through: **redstone** on its own six faces; a **network** of wired
  Silica peripherals (Entity Detector, Item Collector, Item Ejector, Turret, Mob Analyzer, Mob Spawner,
  Keycard Reader, Laser Gate, Geo Scanner); and **Ports**, which mount any *foreign* mod's block (a chest,
  a machine, an energy cube) onto that network.
- A **fresh computer is motherboard + CPU + RAM and nothing else.** Optional parts each unlock one
  capability: **GPU → `gfx`**, **hard drive → `fs`**, **network card (NIC) → `network`**.

---

## 2. READ THIS BEFORE YOU WRITE ANYTHING

Eight constraints. Each has broken real scripts, several of them repeatedly. If you read nothing else,
read these.

1. **A loop must yield.** `while (true) { ... }` with no `os.sleep` or `os.pullEvent` inside it is killed by
   the compute budget. Every loop you write ends in a yield.
2. **Never pace work off the UI.** `os.pullEvent("web_message")` only fires when a player's browser is
   *actually rendering your page*. A control loop parked there stops running when nobody is watching. This
   caused a real reactor meltdown in this mod. Use `os.pullEvent(filter, seconds)` or `os.sleep`. See §6.
3. **No imports, no modules, no `require`, no `fetch`, no `setTimeout`.** A script is one classic script
   file. `import`/`export` is a syntax error.
4. **A missing capability throws — it is not `undefined`.** `gfx.width()` on a computer with no GPU throws
   `capability 'gfx' requires a GPU — none is installed in this computer`. Probe with try/catch and degrade.
   See §7.
5. **A wall screen is 512×384 px by default, and its entire input vocabulary is one click.** No scroll, no
   wheel, no keyboard, no hover, no drag. A scrollable list or a text input simply does not work there. See
   §11.
6. **In CSS, put `html { font-size: clamp(...) }` AFTER any `font:` shorthand that targets `html`.** This
   exact bug shipped **five times** in this mod. See §11.
7. **The page has no authority.** Every client message is forgeable. Validate it server-side; hold all
   state server-side. See §10.
8. **Don't copy numeric limits into your code.** Every limit is a server config knob whose value differs
   per world. Name the knob in a comment; read the real value from the server if you need it.

---

## 3. Which of the two things to write

| | **Terminal script** (Path A) | **App** (Path B) |
|---|---|---|
| Output | `print` lines + the `gfx` canvas | real HTML/CSS/JS |
| Needs | nothing (GPU only for `gfx`) | the **`web-display`** jar, a **GPU**, and a SilicaOS ROM |
| Files | exactly one `.js` | `entrypoint.js` + a `ui/` folder |
| Input | redstone, `mouse_click` on the canvas | clicks in the page |
| Good for | automation, alarms, redstone logic, item moving, anything headless | dashboards, control boards, anything a human reads or drives |

**Decision rule.** Ask: *does a human need to look at this and press things?*

- **No** → write a **terminal script**. It is one file, it runs on a bare computer, and it cannot be broken
  by a viewport. Default to this. Most automation is a terminal script.
- **Yes** → write an **app**. Only if the player said they have `web-display` / a screen / a pad / SilicaOS,
  or asked for a "UI", "dashboard", "screen", "interface" or "buttons".
- If the player asked for automation *and* a display, write a terminal script with a `gfx` readout (the
  shipped starter scripts all do this) — it needs no optional jar.
- If you are unsure, write the terminal script and say in one line what the app version would add.

### File layout — terminal script

```
my-script.js          ← one file, that is all
```

Runs from the computer's script picker. No wrapper, no `main()`, no exported function: the file body *is*
the program, top to bottom.

### File layout — app

```
my-app/
  entrypoint.js       ← runs on the SERVER. Holds all state and all capability access.
  ui/
    index.html        ← the page
    style.css         ← <link rel="stylesheet" href="style.css">   (inlined by the server)
    client.js         ← <script src="client.js"></script>          (inlined by the server)
```

`entrypoint.js` is the unit that runs; it calls `web.openFile("ui/index.html")`. An app folder is launched
from the SilicaOS **Runner**, not the plain script picker. (An app folder that ships only `index.html` and
no `entrypoint.js` is auto-wrapped by the mod as `web.openFile("index.html"); while(true){ os.pullEvent(); }`
— a static page with no server logic. Prefer writing a real `entrypoint.js`.)

---

## 4. The execution model

**Server-side.** Your script runs on the Minecraft server, on a worker thread, inside a GraalJS `Context`
built deny-by-default:

- `allowHostAccess(EXPLICIT)` — only the objects Silica injects are reachable. `Java.type(...)` is dead.
- `allowIO(NONE)` — no file IO of any kind.
- `allowCreateThread(false)`, `allowNativeAccess(false)`, no host class lookup.

**Language level: ECMAScript 2024 (ES15).** GraalJS is pinned at 24.1.2 and Silica sets no
`ecmascript-version` option, so the engine default (ES2024) applies. Scripts are evaluated as **classic
scripts, not modules**. Concretely:

| available | not available |
|---|---|
| `let`/`const`, arrow functions, template literals, classes, class fields, `#private`, static blocks | `import` / `export` / `require` — **syntax error or ReferenceError** |
| destructuring, spread/rest, default params, `for...of` | `fetch`, `XMLHttpRequest`, `WebSocket`, any network |
| `?.`, `??`, `??=`, getters/setters, generators, `Symbol` | `setTimeout`, `setInterval`, `requestAnimationFrame`, any timer |
| `JSON`, `Math`, `Date` (incl. `Date.now()`), `RegExp` (incl. the `v` flag), `Map`, `Set`, `Promise` | `window`, `document` — there is no DOM on the server |
| `String`/`Array`/`Object` methods through ES2024 (`padStart`, `at`, `flatMap`, `Object.groupBy`, …) | `require`/`module`/`exports`, `process`, `Buffer`, `globalThis` host escapes |
| `try`/`catch`/`finally`, `throw` | ES2025+ syntax (iterator helpers, new `Set` methods, import attributes) |

`Promise` exists as a language feature, but **there is no event loop and no timer to resume from**. Do not
use `async`/`await`, promises or microtasks for pacing. The only way to wait is `os.sleep` or
`os.pullEvent`. Write plain synchronous code.

Use **`print(...)`** for output, never `console.log`. `print` takes any number of values, joins them with a
space, and writes one line to the terminal (a process console keeps the newest 200 lines). `console` is not
Silica's output channel — whatever it does or does not do in the engine, nothing you send it reaches the
player. No shipped Silica script uses it.

**Things that do not exist, so do not reach for them:** no monitor API (`os.monitors()` and friends — a
script cannot ask where it is being shown, or move itself); no way for a script to read or write its own
source; no `fs.list()`; no per-app permission grants (doors are server-wide and are resolved **once at
launch**, not per call).

### The compute budget — why loops must yield

A script that runs **continuously without yielding** past the budget is killed with
`[silica] script exceeded the 5000ms compute budget — stopped`.

- The knob is **`maxComputeMillis`** (root of `silica-server.toml`, default **5000** ms, range 50–60000).
- **Parking does not count against it.** `os.sleep` and `os.pullEvent` park the worker off the budget, and
  a parked script can sit there for days.
- On a **smart** computer (SilicaOS ROM installed) up to `maxConcurrentScripts` processes (default 4) share
  **one per-tick budget** under cooperative round-robin. A process that does not yield within its slice is
  killed. So on a smart computer, a greedy loop starves its siblings as well as dying itself.

**There are exactly three yield points:**

| call | blocks until | returns |
|---|---|---|
| `os.pullEvent()` | any event arrives | `Event` |
| `os.pullEvent(filter)` | an event of type `filter` arrives | `Event` |
| `os.pullEvent(filter, seconds)` | that event arrives, **or** `seconds` elapse | `Event`, or **`null`** on timeout |
| `os.sleep(seconds)` | `seconds` elapse | `undefined` |

Timeouts and sleeps are rounded to whole game ticks, **minimum 1 tick** (20 ticks = 1 second), so
`os.sleep(0)` yields one tick and no loop containing either call can busy-spin.

**`os.sleep` discards events that arrive while it is parked. `os.pullEvent` does not.** If you must not miss
a button press or a redstone edge, wait on `pullEvent`, not `sleep`.

Everything else is synchronous and blocking, including every peripheral call.

### Script lifetime

- A script that reaches the end of its file **stops**. If you want it to keep running, loop.
- To leave a final report on screen forever, park: `while (true) { os.pullEvent(); }`.
- On a server restart, a running script **restarts from the top** if `autoResume` is on (default off).
  **Live variables are not restored.** Persist anything that must survive with `fs`.
- A thrown error that is not caught kills the script and prints `[silica] error: <message>` to the terminal.
  Catch what you can recover from.

---

## 5. The complete API surface

Ambient globals. Nothing is imported. Every call below is **synchronous and blocking** unless the table
says it parks.

### `print`

```ts
print(...values)      // → void. Space-separated, one line, to the terminal / process console.
```

### `os`

```ts
os.pullEvent()                     // → Event                 PARKS
os.pullEvent(filter)               // → Event                 PARKS
os.pullEvent(filter, seconds)      // → Event | null           PARKS (null on timeout)
os.sleep(seconds)                  // → void                   PARKS
```

`filter` may be `null` in the two-argument form, meaning "any event type, but keep a clock" — use it when
one loop must handle several event types *and* tick on its own.

An `Event` is `{ type: string, data: unknown }`. `data` is `null` when the event carries none. Non-matching
events are discarded by a filtered `pullEvent`.

### `redstone` — door `redstone`, no part needed

Levels are `0`–`15`. `Side` is one of `"north" | "south" | "east" | "west" | "up" | "down"`.

```ts
redstone.getInput(side)            // → number   incoming level on that face
redstone.getOutput(side)           // → number   the level THIS script has set on that face
redstone.setOutput(side, level)    // → void     clamped to 0–15
```

Four behaviours that catch scripts out:

- **Face names are absolute compass directions. They do not rotate with the block.** `"north"` is north
  whichever way the computer was placed. A wrong name throws
  `unknown side: … (use north/south/east/west/up/down)`.
- **Outputs apply on the next game tick.** `setOutput` then `getInput` on the same face still reads the old
  world. `getOutput` reads back what *you* set, immediately.
- **Inputs are snapshotted once per tick**, so a sub-tick pulse can be invisible.
- The `redstone` event fires for a change on **any** face and carries no data, so always re-read the face
  you care about and compare against your own remembered value (see §8).

### `gfx` — door `gfx`, needs a **GPU**

A retained display list on a **fixed 256×192** virtual canvas, drawn in the computer's GUI and mirrored to
adjacent/wired Screen blocks. Colours are `0xAARRGGBB` numbers; a zero alpha byte is treated as fully
opaque.

```ts
gfx.clear(bg?)                       // → void   clear; with bg, fill with that colour
gfx.rect(x, y, w, h, color)          // → void   filled rectangle
gfx.hLine(x, y, len, color)          // → void
gfx.vLine(x, y, len, color)          // → void
gfx.text(x, y, s, color)             // → void   s truncated to 1024 chars
gfx.sprite(x, y, itemId)             // → void   an item icon, e.g. "minecraft:diamond"
gfx.width()                          // → number always 256
gfx.height()                         // → number always 192
```

The canvas is **not** configurable — but call `gfx.width()` / `gfx.height()` rather than typing `256`/`192`,
because that is the seam a future resizable screen would move. A bigger multiblock screen does not give you
more pixels, it gives you **bigger** pixels: the same 256 × 192 image stretches across the whole face.

Edge behaviours: `gfx.text` uses Minecraft's font, about **9 px tall** in a 192-tall canvas — budget rows
accordingly. `gfx.sprite` with an unknown item id **draws nothing** rather than throwing. `hLine`/`vLine`
with a negative `len` draw nothing rather than reversing.

**Overrunning the display list does not throw.** Past the cap (`[display] gfxMaxCommands` in count, and a
byte bound derived from `appStateMaxChars`) the draw is dropped, one line goes to the terminal, and **every
further draw is silently discarded until `gfx.clear()`**. The symptom in play is a screen that stops
updating. So: **redraw each frame starting with `gfx.clear()`**, never append forever.

**`gfx.sprite` renders in the computer's own GUI. Item icons on an external screen block are still
outstanding**, so a wall dashboard must never depend on a sprite for meaning — pair every icon with text. A
Path-B page cannot show item icons at all (the embedded browser cannot reach the game's texture atlas).

### `fs` — door `fs`, needs a **hard drive**

A flat key→string store on the disk item in the computer's drive.

```ts
fs.read(name)                      // → string | null   null if the key is absent
fs.write(name, data)               // → void            bounded by [memory] fsMaxBytes
fs.has(name)                       // → boolean
fs.delete(name)                    // → boolean         whether it existed
```

- **An empty drive throws** `no disk in drive` on all four calls — it does not degrade to `null`. That is
  separate from the `fs` door (no HDD ⇒ the global itself throws), so on a machine whose disk may be pulled,
  guard the *call* as well as the door.
- **Over the size cap it throws** `disk full: …`. `[memory] fsMaxBytes` counts **keys and values together**.
- **There is deliberately no `fs.list()`.** If you need to enumerate what you saved, keep your own index
  key (e.g. a JSON array under `"index"`).
- `fs.write(name, null)` stores an **empty string**; it does not delete. Use `fs.delete(name)`.
- On a smart computer **every process shares one disk**, so namespace your keys (`"myapp.count"`).
- `fs.read` returns `null` for an absent key — `parseInt(null, 10)` is `NaN`, so check with `isNaN`.

### `network` — door `network`, needs a **NIC**

Reaches blocks wired to the computer (directly, through a Switch or cable junction, or via a
Router → Receiver pair), peripherals face-adjacent to any node, and — across an MD switch on a shared
channel — devices in other dimensions.

```ts
network.devices()                  // → Device[]        everything reachable
network.find(idOrLabel)            // → Device | null   by auto-id or player label
network.send(idOrLabel, payload)   // → void            to ONE computer; JSON-serializable; capped by [networking] netMessageMaxBytes
network.broadcast(payload)         // → void            to every computer on the network
```

A message arrives at the other end as an `os.pullEvent("net_message")` with `data` = `{ from, payload }`
(`from` is the sender's device id).

- **A broadcast never comes back to its sender** — one beacon alone sees no peers, which is why a
  heartbeat script needs a second computer to be worth anything.
- **`network.send` to a name that is not on the network throws** `no computer named '…' on the network` — it
  is not a silent drop. Catch it.
- A payload that is not JSON-serializable throws `payload is not JSON-serializable`.
- `network.send` addressed to **your own** label does deliver to yourself.
- The device count is bounded by `[networking] networkMaxDevices`.

### `Device`

```ts
device.id            // string   stable auto-id, e.g. "port_1a2b", "detector_3c4d"
device.label         // string | null   the screwdriver-assigned name; addressable by it
device.kind          // string   see the kind list below
device.online        // boolean  false if the chunk is unloaded or the block is gone
device.faculties     // string[] which sub-surfaces work — TEST THIS, it is load-bearing
```

`kind` is one of `"port"`, `"receiver"`, `"computer"`, `"screen"`, `"detector"`, `"collector"`,
`"ejector"`, `"turret"`, `"analyzer"`, `"spawner"`, `"keycard_reader"`, `"laser_gate"`, `"geo_scanner"`, one
of the integration kinds in §5.9, or an unknown string (any mod can join the surface). **Never assume the
list is closed.**

**`faculties` is the honest answer to which sub-surface works on this device.** Four sub-surfaces, and they
do *not* all serve every kind:

| sub-surface | works on | `faculties` entry |
|---|---|---|
| `call` | a Silica peripheral, or a **Port/receiver** whose mounted block exposes a foreign peripheral | `"peripheral"` |
| `items` | a **Port/receiver** (the mounted block's inventory) **and** a collector / ejector (its own buffer) | `"items"` |
| `redstone` | a **Port/receiver only** — the mounted block's redstone, never the device's own | `"redstone"` |
| `energy()` | a **Port/receiver only** | `"energy"` |
| `fluids` | a **Port/receiver only** | `"fluids"` |

A Port/receiver always lists `"redstone"` and adds the others as the mounted block supports them. A Silica
peripheral lists `["peripheral"]`, plus `"items"` when it has a buffer of its own (collector, ejector) —
never `"redstone"`, deliberately. A **computer** or **screen** lists nothing.

Calling an endpoint-only facet on a Silica peripheral throws **`"device offline"`** — a misleading message
that means *wrong kind of device*, not *chunk unloaded*. **Test `faculties`, not `online`, before reaching
for one:**

```js
if (d.faculties.indexOf("energy") >= 0) { const e = d.energy(); }
```

#### `device.call(method, args?)` — the one dispatch path for every peripheral verb

```js
const rows = detector.call("scan");                     // → DetectorRecord[]
detector.call("config", { range: 12, filter: ["mob"] }); // args is a plain object
```

Returns whatever the verb answers, marshalled as JSON-ish values. An unknown verb throws. A welded door
throws. A device with no peripheral faculty throws `"device has no peripheral faculty"`.

**A verb runs on the server tick thread.** Keep polling slow and per-device calls few — a slow foreign call
stalls all ticking, and a target that repeatedly overruns `peripheralBreakerThresholdMs` is refused for a
cooldown with a catchable *"device busy"*.

#### `device.redstone` — Port/receiver only

```ts
device.redstone.set(level)   // → void    boolean (on = 15 / off = 0) or an explicit 0–15
device.redstone.get()        // → number  the level the mounted block EMITS BACK, not what you set
```

A lamp you drive still reads `0` from `get()`.

#### `device.energy()` — Port/receiver only

```ts
device.energy()              // → { stored: number, capacity: number }
```

Throws `"device has no energy faculty"` on a Port whose block stores no energy. A Silica peripheral that
holds FE reports it in its own status verb instead (`TurretStatus.energy`, `SpawnerStatus.buffered`,
`GeoStatus.energy`), **not** here.

#### `device.items` — Port/receiver, plus collector and ejector buffers

```ts
device.items.list()          // → ItemStackInfo[]   NON-EMPTY slots only
device.items.summary()       // → { slots, scanned, used, free, totals }
device.items.detail(slot)    // → ItemStackInfo & { components, truncated } | null
device.items.move(to, opts?) // → number   how many actually moved
```

```ts
ItemStackInfo = {
  slot: number,        // the real slot index — NOT the array index; empty slots are skipped
  id: string,          // "minecraft:oak_log"
  count: number,
  name: string,        // "Oak Log" — resolved in the SERVER's locale, not the viewer's
  maxCount: number,    // stack limit; 1 for a tool
  damage: number,      // durability used; 0 if undamaged/undamageable
  maxDamage: number,   // 0 when the item has none — GUARD BEFORE DIVIDING
  tags: string[]       // every item tag, sorted, e.g. ["minecraft:logs","minecraft:oak_logs"]
}
```

- **`list()` throws on size** past the `[memory] itemsMaxSlots` knob (default 1024):
  `"inventory too large — 4096 slots, cap 1024; use summary()"`. Deliberate — a partial list would make a
  sorter move the wrong items.
- **`summary()` never throws on size.** It walks at most `itemsMaxSlots` slots and reports both the true
  `slots` and how many it `scanned`, so `scanned < slots` tells you the walk was cut short. `totals` is
  `item id → total count`, aggregated server-side, in first-seen order. Put the two reads in **separate
  try blocks** so a huge storage block still gets a fill bar.
- **`detail(slot)`** costs one game-thread round trip per call — drive it from a click, never from a poll
  or a timer. `components` holds only what the stack carries *beyond* its item's defaults (a plain
  cobblestone stack reports `{}`). If `itemComponentMaxDepth` / `itemComponentMaxNodes` fire, the record
  comes back with `truncated: true`. Returns `null` for an empty slot; throws
  `"no such slot 99 — inventory has 54 slots"` for a slot that does not exist.
- **`move(to, opts?)`** is simulate-then-execute: it can never dupe or void. `opts` is
  `{ id?: string, count?: number, fromSlot?: number }`.

**`tags` is what makes a sorter survive a modpack.** `s.tags.indexOf("c:ingots") >= 0` keeps working when
the player installs a mod; a hardcoded list of item ids does not.

#### `device.fluids` — Port/receiver only

```ts
device.fluids.list()   // → { tank: number, id: string, amount: number, capacity: number }[]
```

A collector's or ejector's own liquid-chip tank is **not** here — read it with `call("tank")`.

### `pads` — door `pads`, no part needed

Pads bound to this computer. **Pads do not appear in `network.devices()`.** Coverage is a Router's
effective range (`routerRange` plus any range chip); wifi is mandatory.

```ts
pads.list()            // → Pad[]           every loaded bound pad
pads.find(idOrLabel)   // → Pad | null

pad.id                 // string
pad.label              // string | null
pad.online             // boolean   loaded + in coverage + battery alive
pad.setColor(color)    // → void    "#rgb" / "#rrggbb" or one of the 16 dye names. Throws when offline.
```

### `web` — door `web`, needs the **`web-display`** jar

```ts
web.open(html)          // → void   publish an HTML document as this computer's app; replaces what was open
web.openFile(path)      // → void   open an author-written file, inlining its siblings (THE multi-file path)
web.setState(state)     // → void   push a JSON state snapshot to every viewer (full replace)
web.close()             // → void   close the app and blank every viewer
```

Guard with `typeof web !== "undefined"` in a script meant to run either way. See §10 for the full Path-B
contract.

### Peripheral verbs, by `kind`

Every one of these blocks also works with **no computer**, through its own GUI and (where it has one) a
redstone output. The script path is the upgrade, not the only way in.

#### `detector` — Entity Detector · door `detector`

| verb | args | returns |
|---|---|---|
| `scan` | — | `DetectorRecord[]` — the latest filtered sweep (the block scans on its own clock) |
| `config` | `{ range?, filter? }` | `{ filter, range }`. No args = read only |

```ts
DetectorRecord = {
  kind: "mob" | "player",
  name: string,                        // player name, or the entity type's name
  pos: { x, y, z },
  dx: number, dz: number,              // HORIZONTAL offsets from the block, 1 dp — plot these directly
  dist: number,                        // 3-D distance from the block, 1 dp
  hostile: boolean                     // a player is never hostile here
}
```

`range` is clamped server-side to `[1, detectorMaxRange]` (default **and** hard maximum 24). `filter` is
any subset of `"mob" | "player" | "friendly" | "enemy"`, OR-ed: a player matches iff `"player"` is
selected; a mob matches if `"mob"` is selected, else `"enemy"` catches a hostile one and `"friendly"` a
non-hostile one.

- **An empty filter matches nothing** — the block goes silently blind. Read `config().filter.length` once at
  start-up and warn if it is `0`; otherwise your alarm can never trip and nothing says why.
- **`scan()` returns a cache**, refreshed on the block's own `detectorScanInterval`. Polling it faster than
  that buys nothing.

#### `collector` — Item Collector · **no door**

| verb | args | returns |
|---|---|---|
| `contents` | — | `{ item: string, count: number }[]` — the 27-slot buffer's non-empty stacks |
| `config` | `{ range?, mode?, filter? }` | `{ range, mode, filter }`; `mode` is `"whitelist" \| "blacklist"`, `filter` a list of item ids |
| `tank` | — | `{ fluid, amount, capacity }` in mB; `fluid` is `"minecraft:empty"` when dry |

There is deliberately **no `collect` verb** — it vacuums autonomously. Note that `mode: "whitelist"` with an
**empty** `filter` collects nothing at all; the same trap applies to the ejector.

#### `ejector` — Item Ejector · door `ejector`

| verb | args | returns |
|---|---|---|
| `contents` | — | `{ item, count }[]` |
| `config` | `{ mode?, filter? }` | `{ mode, filter, facing }` — `facing` is read-only (re-aim with shift+screwdriver) |
| `eject` | — | `EjectResult` |
| `tank` | — | `{ fluid, amount, capacity }` |

```ts
EjectResult = {
  ejected: boolean,
  reason: string,      // "none" when ejected; else "unloaded" | "buffer empty" | "filtered out"
                       // | "face blocked" | "destination full" | "placement refused" | "toss refused"
  item: string | null, // what left, or null on a refusal
  action: "insert" | "place" | "toss" | null,
  contents: { item, count }[]   // the buffer that is LEFT
}
```

`eject()` forces **one item cycle now**, bypassing the interval timer, the redstone disable and the energy
gate — but not the world: a blocked face or a full destination still refuses, and says which. **Items
only**; the liquid chip's fluid pass runs on the block's own interval.

#### `turret` — door `turret`

| verb | args | returns |
|---|---|---|
| `status` | — | `TurretStatus` |
| `scan` | — | `TurretRecord[]` |
| `fire` | `{ x?, y?, z? }` | `{ fired: boolean, target: string \| null, damage: number }` |
| `aim` | `{ x?, y?, z? }` | `{ aimed: boolean }` |
| `config` | `{ enabled?, useDetector? }` | `{ enabled, useDetector, targeting, friendlyFire, range }` — the last three read-only |

```ts
TurretRecord = {                       // NOT a DetectorRecord — there are NO dx/dz here
  kind: "mob" | "player", name: string,
  pos: { x, y, z },                    // absolute, unrounded — compute offsets yourself for a radar
  dist: number,                        // 3-D distance from the turret head, 1 dp
  hostile: boolean
}

TurretStatus = {
  energy, capacity, fePerShot, damage, shotsPerSecond,
  color,                               // installed lens tier; 0 = none, therefore INERT
  wireless, enabled, useDetector, range,
  targeting: "all_mobs" | "hostile_only" | "off",
  headPresent: boolean,                // without a head, fire NEVER fires
  durability: number | null,           // null when no head is attached
  maxDurability: number
}
```

**`fire` takes `{x, y, z}` — there is no `target` argument.** The head is fixed and **rotates for nothing**;
the coordinates name a *point*, and the turret shoots the nearest valid entity **to that point** (in arc,
line of sight clear, not the owner, not blacklisted). `fired` is `false` with no head, no lens
(`status().color === 0`), less FE than `status().fePerShot`, or nothing valid in range.

**Supply all three coordinates or none.** `fire` and `aim` check for `x` **and** `y` **and** `z`; a partial
set such as `{ x: 10 }` is **silently** treated as "no coordinates" and shoots the nearest valid entity to
the turret itself. Pass `{}` deliberately, or a full triple — never a partial one.

**`aim` rotates nothing either.** It is a reachability *test*: whether the point lies inside the firing arc
(±`[turret] maxPitch` of horizontal; azimuth unrestricted), so a script can check a target's elevation
before spending a shot. Called with no coordinates it trivially answers `true`.

`scan()` lists everything alive and in range **including entity types the turret will refuse to shoot**.

#### `analyzer` — Mob Analyzer · door `detector` (same entity-sensing surface)

| verb | args | returns |
|---|---|---|
| `status` | — | `AnalyzerStatus` |
| `scan` | — | `{ target, bound, completeness, tier, powered }` — **one object, not a list** |
| `config` | `{ range? }` | `{ range }` |

```ts
AnalyzerStatus = {
  target: string | null,      // the entity being scanned; null when paused (target left or died)
  bound: string | null,       // the entity type the loaded datasheet is bound to; null for a blank sheet
  completeness: number,       // 0–100
  tier: number,               // rarity 1–5
  powered: boolean,
  fe: number,                 // current FE/tick draw
  redstone: boolean,          // TRUE means a signal is holding the analyzer OFF — not "a signal exists"
  chip: number,               // speed-chip tier, 0 = none
  range: number
}
```

`scan()` is the first five fields of `status()` on their own. If you want everything, call `status()`.
A datasheet tops up across sessions and is never consumed.

#### `spawner` — Mob Spawner · door `spawn`

| verb | args | returns |
|---|---|---|
| `status` | — | `SpawnerStatus` |
| `config` | `{ enabled? }` | `{ enabled }` |
| `spawn` | — | `{ started: boolean, stall: string }`, **plus `spawnSeconds` when `started` is true** |

```ts
SpawnerStatus = {
  bound: string | null, tier: number, completeness: number, enabled: boolean,
  progress: number,       // 0–100 of the current cycle
  spawnSeconds: number,   // one cycle after the speed chip
  fePerTick: number, buffered: number,
  stall: string           // the blocker holding the cycle, or "none" while one runs
}
```

One armed cycle only: the spawner returns to disabled afterwards and the full cycle time and FE cost are
still paid, so calling `spawn()` in a loop cannot out-spawn the throttle. Sleep `spawnSeconds` rather than
polling.

#### `keycard_reader` — door `security`

Callable only from a computer **bound to the reader** or **owned by the same player**.

| verb | args | returns |
|---|---|---|
| `status` | — | `ReaderStatus` — the only verb an **unbound** reader answers |
| `lock` / `unlock` | — | the fresh `ReaderStatus` (no follow-up call needed) |
| `config` | `{ autoLockSeconds?, autoOpenOnUnlock? }` | the same two fields back |
| `revoke` | `{ card }` | `{ result: string, cards: number }` |

```ts
ReaderStatus = {
  label: string | null,
  door: {
    bound: boolean,       // bound AND reachable; an unloaded door reads false
    pos: { x, y, z } | null, dimension: string | null,
    locked: boolean, open: boolean,
    autoLockSeconds: number, autoOpenOnUnlock: boolean
  },
  cards: { id: string, tier: "owner" | "normal", enrolledBy: string | null }[],
  armed: boolean
}
```

`revoke`'s `result` is `"revoked"`, `"not_paired"` or `"last_owner"` — the last owner card can never be
revoked; `card` is required. There is deliberately **no `pair` verb**: minting a key stays a physical,
owner-present act. Every verb but `status` throws when there is no reachable door, and the verbs also need
**router coverage**, not merely a wire.

#### `laser_gate` — door `security` (reused)

Same cards, same reader, same authorization model as the Secure Door.

| verb | args | returns |
|---|---|---|
| `status` | — | `LaserGateStatus` |
| `lock` / `unlock` | — | the fresh `LaserGateStatus`; drives the **whole assembly** |
| `config` | `{ autoLockSeconds?, autoOpenOnUnlock? }` | those two plus the read-only `damageInterval` |
| `revoke` | `{ card }` | `{ result, cards }` |

```ts
LaserGateStatus = {
  label: string | null, controller: { x, y, z } | null,
  members: number, beams: number, litBeams: number,
  truncated: boolean,        // the assembly hit its size cap and is reported partially
  claimed: boolean, locked: boolean, armed: boolean, powered: boolean,
  lensTier: number, autoLockSeconds: number,
  cards: { id, tier, enrolledBy }[]
}
```

`autoOpenOnUnlock` is a stored no-op on a gate (unlocking *is* opening) but is accepted and reported, so
one script can configure either kind of target blind. Armed beams are lethal to **everything living, the
owner included**. Every verb but `status` throws when the elected controller is not loaded.

#### `geo_scanner` — door `geo`

One-shot: it **pulses** rather than scanning continuously. The swept volume is a cube hanging entirely
*below* the machine (top face at Y−1, edge `2r+1`). Range chips only.

| verb | args | returns |
|---|---|---|
| `pulse` | — | `{ started: true, sweepTicks }` or `{ started: false, cooldownTicks }` |
| `status` | — | `GeoStatus` |
| `survey` | — | `GeoSurvey` — the aggregate, with an honest per-Y tally taken *before* the hit cap |
| `veins` | — | `GeoVein[]`, **nearest first** |
| `scan` | — | `{ hits: { block, x, y, z }[], truncated: boolean, cap: number }` — raw blocks, Y-biased by the cap |
| `diff` | — | `{ removed: string[], added: string[] }` — **vein ids**, against the one retained previous survey |
| `focus` | `{ id }` (a bare id string also works; empty clears) | the focused `GeoVein` or `null`; also aims a prospector's compass |
| `config` | `{ radius?, filter?, compassTarget? }` | `{ filter, radius, edge, depth, compassTarget }` |

```ts
GeoVein = {
  id: string,             // stable across partial mining — safe to keep between pulses
  block: string, count: number,
  centre: { x, y, z }, dx, dy, dz, dist,
  bearing: number, cardinal: string,
  depth: number,          // blocks below the machine
  typeCount: number,      // blocks of this ore type in the whole survey
  rarity: number          // 1 - typeCount/survey.total. HIGHER IS RARER. Per-ORE, not per-vein.
}

GeoStatus = {
  pos: { x, y, z }, dimension: string | null,
  scanning: boolean, progress: number,   // 0–100 of the current sweep
  radius, edge, depth, maxRadius,
  clampedByServer: boolean,              // the configured radius exceeded geoScannerMaxRange
  chip: number, cooldownTicks: number, hasResult: boolean, ageTicks: number,
  partial: boolean,                      // the sweep could not finish — results are PARTIAL
  skippedChunks: number, feDraw: number, energy: number,
  focused: GeoVein | null
}

GeoSurvey = {
  tally: Record<string, number>,   // ore id → block count for the whole sweep
  total: number, veinCount: number, radius, edge, depth, ageTicks,
  partial: boolean, skippedChunks: number,
  byY: { y: number, count: number }[]   // ASCENDING absolute world Y, SPARSE (empty layers omitted)
}
```

- `veins()` is **nearest first**, not rarest first — sort by `rarity` descending yourself for a
  prospector's list.
- `scan()` is the wrong input for a per-Y histogram (the cap makes it Y-biased); `survey().byY` is the
  honest one.
- **`config.filter` accepts `#tag` strings as well as block ids and defaults to `#c:ores`** — which makes the
  Geo Scanner a general block finder, not just an ore finder.
- `focus` with an **unknown** id clears the focus, exactly as an empty argument does — so check the return
  for `null` rather than assuming it stuck.
- Relevant knobs: `geoScannerMaxRange`, `geoScannerMaxResults`, `geoScannerMaxVeins`,
  `geoScannerCooldownTicks`.

### Foreign blocks — the integration adapters

Each is an **optional jar** that loads only when its target mod is present, reached through a **Port**
mounted on the foreign block. The cable is the only gate — no extra door. Verb names only; the return
shapes mirror another mod's data model and are not typed in Silica's reference, so **read a `getStatus()`
result at runtime rather than assuming its fields**.

| `kind` | verbs |
|---|---|
| `mekanism_machine` | `getStatus`, `getChemicals`, `getHeat`, `getRadiation` |
| `mekanism_fission_reactor` | `getStatus`, `activate`, `scram`, `setBurnRate` — read **`rateLimit`**, not `burnRate`, when adjusting a set point |
| `mekanism_turbine` | `getStatus`, `setDumping` — **`setDumping` is a turbine control, not a reactor one** |
| `rftools_builder` | `getStatus`, `start`, `stop`, `restart`, `setRedstoneMode`, `setFlags` |
| `rftools_powercell` / `rftools_dimensionalcell` | `getStatus` (network-wide aggregates, incl. cross-dimension) |
| `rftools_endergenic` / `rftools_coal_generator` / `rftools_blazing_generator` | `getStatus` |
| `refinedstorage_network` | `getStatus`, `listItems`, `listFluids`, `listChemicals`, `getItem`, `getFluid`, `getEnergy`, `getPatterns`, `getTasks`, `isCrafting`, `craftItem`, `cancelTask`, `cancelAll`, `extractItem`, `insertItem`, `extractFluid`, `insertFluid` |

Any mod can join this surface without Silica knowing about it, so `kind` is an open set.

---

## 6. The rule that caused a real reactor meltdown

**Automation must never be client-paced.**

`web_message` is posted only by a packet from a **viewing player's browser**. When nobody is looking at the
screen, no `web_message` is ever produced. So this:

```js
// ✗ WRONG — a control loop that only advances when someone is watching.
while (true) {
  const ev = os.pullEvent("web_message");   // parks FOREVER once the last viewer walks away
  handle(ev);
  checkInterlocks();                        // never runs again
}
```

...stops running the moment the last viewer leaves. In this mod that emptied a reactor's interlock loop and
melted it down. The same trap applies to `mouse_click` and `pad_touch`.

**The correct pattern — the server owns the cadence.** Use the timed form, which returns `null` on timeout:

```js
// ✓ RIGHT — the loop ticks on the SERVER's clock and stays responsive to viewers.
const SWEEP_MS = 1500;
let nextSweepMs = 0;

function markSwept() { nextSweepMs = Date.now() + SWEEP_MS; }

// How long to park next: whatever is LEFT on the deadline, so an arriving message does not restart the
// clock. Capped so a backwards clock jump can't park for hours; floored at 0. pullEvent rounds any value
// up to one whole tick, so this can never busy-spin.
function waitSeconds() {
  let left = nextSweepMs - Date.now();
  if (left > SWEEP_MS) { left = SWEEP_MS; }
  if (left < 0) { left = 0; }
  return left / 1000;
}

sweep();          // read the device, web.setState(...)
markSwept();

while (true) {
  const ev = os.pullEvent("web_message", waitSeconds());   // null on timeout

  if (ev) {
    // A viewer asked for something. Answer from CACHE where you can — a filter change or a poll is a
    // VIEW change, not a device question, so ten people clicking costs the tick thread nothing.
    handleMessage(ev);
    publishFromCache();
  }

  // The clock tick: the one authoritative device read, whether or not anyone is watching.
  if (!ev || Date.now() >= nextSweepMs) {
    sweep();
    markSwept();
  }
}
```

Three properties this buys, and they are the reasons to copy it:

1. **Exactly one device read per `SWEEP_MS`, however many people are watching.** With the untimed form the
   loop advances once per *viewer poll*, so five viewers cost five times the peripheral calls — the viewer
   count, not the app, setting the server load.
2. **Interlocks, alarms and control keep running with nobody present.**
3. **Re-arm from *now*** (`nextSweepMs = Date.now() + SWEEP_MS`), never `nextSweepMs += SWEEP_MS`. After a
   lag spike the next cycle is simply late; it never queues a catch-up burst of sweeps into an already
   struggling tick thread.

`Date.now()` is a plain ECMAScript intrinsic and works in the sandbox. If you want the shipped apps'
belt-and-braces, guard it (`typeof Date !== "undefined" && typeof Date.now === "function"`) and fall back
to a message-counted debounce; that is optional polish, not required.

**When the untimed form IS correct:** an app that owns no device and does no work between clicks — a
calculator, a counter, a notes pad. State is retained and replayed to a new viewer automatically, so
nothing is lost by parking. The shipped `counter` app does exactly this and documents why. Anything that
reads a peripheral or holds an interlock uses the timed form.

For a purely headless loop with no UI at all, `os.sleep(seconds)` is the right yield — but remember it
**discards** events, so use `os.pullEvent("redstone")` instead if you must not miss an edge.

---

## 7. Capability doors and computer parts

Every host capability routes through one chokepoint. A door is **default-open**; a server admin can weld
one shut in `silica-server.toml` `[capabilities]`, and a door is also closed by **missing hardware**.

**A closed door binds a throwing stub, not `undefined`.** The global still *looks* present (`typeof` is
`"object"`), and **any** access — even reading a field — throws a catchable error naming the door and the
reason:

- welded: `capability 'redstone' is disabled on this server`
- missing part: `capability 'gfx' requires a GPU — none is installed in this computer`

There are **thirteen** doors.

| door | gates | opened by |
|---|---|---|
| `redstone` | driving and reading redstone on the computer's own faces | nothing — always available unless welded |
| `gfx` | the terminal canvas / display list | a **GPU** |
| `fs` | the computer's saved filesystem | a **hard drive (HDD)** |
| `network` | wired blocks and other computers, incl. all `device.call` | a **network card (NIC)** |
| `pads` | bound pads and pocket computers (display path — **no NIC needed**) | nothing |
| `web` | a real HTML/CSS/JS interface | the optional **`web-display`** jar (+ MCEF). No server-side switch — an admin disables it by removing the jar |
| `detector` | the Entity Detector's **and** Mob Analyzer's own verbs | — |
| `ejector` | the Item Ejector's own verbs | — |
| `turret` | the Turret's own verbs | — |
| `spawn` | the Mob Spawner's own verbs | — |
| `security` | the Keycard Reader's **and** Laser Gate's own verbs | — |
| `geo` | the Geo Scanner's own verbs | — |
| `multidimensional` | reaching a network that crosses dimensions | — |

The six peripheral doors are checked **at `device.call` dispatch**, on top of the `network` transport the
call already rides. A peripheral door gates only that peripheral's **own verbs**: reading an inventory is
generic, so listing what is inside a Collector needs `network` and **no** peripheral door. Welding one
leaves that block's standalone GUI and redstone behaviour untouched — it only closes the script path.

`multidimensional` is a **behavioural** gate, not a registered door: welded shut, MD gear degrades to
same-dimension-only rather than throwing.

### Degrade, never throw

**A good script loses a feature when a door is shut; it does not die.** The shipped starter scripts all
open with the same probe, and you should copy it:

```js
// A door you lack throws on every access, so the only way to ask is to try it and catch.
function probe(fn) { try { fn(); return true; } catch (e) { return false; } }

const HAS_RS  = probe(function () { redstone.getInput("north"); });
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_FS  = probe(function () { fs.has("probe"); });
const HAS_NET = probe(function () { network.devices(); });
const HAS_WEB = (typeof web !== "undefined");
```

Then guard every use, and **say what was lost**:

```js
if (!HAS_GFX) { print("no GPU, so no screen readout — the redstone still works."); }
```

If the script's whole purpose needs a door that is shut, **park with a readable message** rather than
crashing:

```js
if (!HAS_NET) {
  print("this computer has no network card. Install a NIC to reach the network.");
  while (true) { os.pullEvent(); }   // park rather than crash: the message stays readable
}
```

### Computer parts, and what to declare

| part | opens | needed for |
|---|---|---|
| motherboard + CPU + RAM | — | the minimum to boot. Every computer has these |
| GPU | `gfx` | the canvas; **also required by SilicaOS**, so every Path-B app needs one |
| HDD | `fs` | stored scripts and saved files |
| NIC | `network` | everything on the network |
| SilicaOS ROM | — | the desktop, the Runner, multiple concurrent processes; **required to launch an app folder** |

A **smart** computer = SilicaOS ROM + GPU + `web-display` present. That is what runs apps. Redstone needs
no part at all.

### The error messages you will actually catch

Useful both for writing `catch` blocks and for telling the player what a message means.

| message | means |
|---|---|
| `capability '<door>' is disabled on this server` | an admin welded that door |
| `capability 'gfx' requires a GPU — none is installed in this computer` | missing part (same shape for `fs`/HDD and `network`/NIC) |
| `[silica] script exceeded the 5000ms compute budget — stopped` | a loop did not yield |
| `[silica] error: <message>` | an uncaught throw killed the script |
| `device offline` | usually **wrong kind of device** for that facet, *not* an unloaded chunk. Check `faculties` |
| `device has no items faculty` / `no energy faculty` / `no peripheral faculty` | this device genuinely lacks it |
| `device busy: … is throttled after a slow response (retry shortly)` | the peripheral breaker tripped. Retry later; do not hammer |
| `inventory too large — 4096 slots, cap 1024; use summary()` | past `itemsMaxSlots`; `summary()` still works |
| `no such slot 99 — inventory has 54 slots` | `detail()` on a slot that does not exist |
| `no disk in drive` | the drive is empty (distinct from the `fs` door) |
| `disk full: …` | past `fsMaxBytes` (keys + values together) |
| `unknown side: … (use north/south/east/west/up/down)` | a bad face name |
| `no computer named '…' on the network` | `network.send` to an unknown label/id |
| `payload is not JSON-serializable` | `send`/`broadcast` given something it cannot encode |
| `web.openFile: no such file: …` | the entry path is wrong (a missing **sibling** fails silently instead) |
| `web app HTML too large: … (raise [display] appDocMaxChars, ceiling …)` | over the document cap |
| `web state too large: … (raise [display] appStateMaxChars, ceiling …)` | over the state cap |
| `No power — connect an energy source` | the computer has no FE |

There is also a **heap watchdog**: past `[heapWatchdog] thresholdPercent` it kills the longest-running
active script. Another reason to keep working sets small and bounded.

---

## 8. Events

`os.pullEvent` returns `{ type, data }`. **Eight** event types exist.

| `type` | fires when | `data` |
|---|---|---|
| `redstone` | an input level on **any** of this computer's own faces changed | `null` — re-read the face you care about |
| `mouse_click` | a click on the `gfx` canvas **in the computer's own GUI** | `{ x, y, button }` — canvas pixels; button `0`=left, `1`=right, `2`=middle |
| `net_message` | another computer sent this one a message | `{ from, payload }` |
| `web_message` | a Path-B page called `mc.send` | the **raw JSON string** the page sent — `JSON.parse` it |
| `pad_touch` | an empty-hand click on a pad face that **no browser took** | `{ display, player, x, y }` |
| `card_swipe` | a keycard was presented to a reader — **accepted *or* rejected** | `{ reader, card, tier, accepted }` |
| `gate_contact` | something touched an armed laser beam | `{ gate, entity, name, x, y, z, member }` |
| `gate_breach` | a member block left an armed laser gate assembly | `{ gate, cause, x, y, z }` |

Payload details that scripts get wrong:

```ts
// pad_touch
{ display: string,   // the touched pad's label, or its auto-id if unnamed
  player: string,    // the touching player's name
  x: number, y: number }   // hit position across the face, NORMALIZED 0–1 (x right, y down)

// card_swipe — there is NO `player` field, and never was.
{ reader: string,                            // the reader's label, falling back to its network auto-id
  card: string | null,                       // null for a never-paired blank
  tier: "owner" | "normal" | null,           // null for a stranger's card or a blank
  accepted: boolean }                        // whether the door actually unlocked

// gate_contact
{ gate: string,      // the assembly's label, falling back to its controller's auto-id
  entity: string,    // registry id, e.g. "minecraft:zombie"
  name: string,      // display name
  x, y, z,           // where the entity was, absolute
  member: { x, y, z } }   // the gate block whose beam it touched

// gate_breach
{ gate: string,
  cause: "overload" | "broken",   // "overload" = a lens-mismatch detonation
  x, y, z }                       // the member that went
```

`gate_contact` is rate-limited per entity and capped per damage pulse, so a mob standing in a beam does not
flood the queue. `card_swipe` delivery is owner-gated. The event queue itself is bounded by
`[memory] eventQueueMax`.

**`mouse_click` comes only from the computer's own GUI.** Clicking a wall screen that is showing a `gfx`
canvas produces **no event at all** — a `gfx` wall screen is display-only. If you want a clickable wall
surface, that is Path B, not `gfx`.

**`web_message`, `mouse_click` and `pad_touch` are viewer-gated by construction** — they need a player
present. Never build a control loop that only advances on one of them (§6).

### The idiomatic event loop

Reacting to a redstone **edge**, not a level — a lever held on must be one flip, not thousands:

```js
// pullEvent, not sleep: os.sleep DISCARDS events, so a button press during the nap would be lost.
// The event fires for a change on ANY face, which is why we re-read IN_SIDE and compare.
let wasHigh = redstone.getInput(IN_SIDE) > 0;
while (true) {
  os.pullEvent("redstone");
  const high = redstone.getInput(IN_SIDE) > 0;
  if (high && !wasHigh) { doTheThing(); }
  wasHigh = high;
}
```

Handling several event types **and** keeping a clock — pass `null` as the filter:

```js
while (true) {
  const ev = os.pullEvent(null, 1);        // any event, or null after ~1s
  if (ev && ev.type === "card_swipe") { logSwipe(ev.data); }
  if (ev && ev.type === "redstone")   { readFaces(); }
  tick();                                   // runs every second regardless
}
```

A pure timer, no events needed:

```js
while (true) {
  doOneRound();
  os.sleep(POLL_SEC);
}
```

---

## 9. Trust and validation

**The page has no capabilities.** It is a view and an input layer: it messages your script, and your script
acts. A client message is a **forgeable network packet**. This is the whole trust boundary, and no amount of
client-side hiding changes it.

Validate every message on the server:

```js
let msg;
try { msg = JSON.parse(ev.data); } catch (e) { continue; }   // ignore anything that isn't valid JSON

switch (msg && msg.action) {                                  // ALLOWLIST, never a computed dispatch
  case "inc":   count += 1; break;
  case "reset": count = 0;  break;
  default:      continue;                                     // unknown action → ignore
}
```

Coerce numbers explicitly — `Number("")` and `Number(null)` are both `0`, so coercing a missing field
would turn it into a real value:

```js
const slot = (typeof raw === "number" && isFinite(raw)) ? Math.floor(raw) : -1;
```

The server **overwrites** any `source` field a page supplies (see §10), so identity is always the server's
word. Trust `source`; trust nothing else in the message.

Never write anything hostile: no griefing, no wiping storage, no draining power, no chat spam, no attempt
to escape the sandbox or exhaust the server. Your entry runs in other people's worlds, usually unread.

---

## 10. Path B — the server/page seam

Four calls are the entire bridge. That is not a simplification; it is the whole contract.

| where | call | what it does |
|---|---|---|
| `entrypoint.js` | `web.openFile("ui/index.html")` | publish the document, once, at startup |
| `entrypoint.js` | `web.setState(obj)` | push authoritative state to every viewer (full replace) |
| `ui/client.js` | `mc.onState = fn` | the page receives that state and renders it |
| `ui/client.js` | `mc.send(obj)` | the page **asks**; it never decides |

### Server side

- **`web.openFile(path)`** resolves relative to the app's own folder (`"ui/index.html"` →
  `"<app>/ui/index.html"`; for a bare root script the base is the library root). It **inlines the entry
  file's siblings** into one self-contained document: `<link rel="stylesheet" href="...">` becomes
  `<style>`, and `<script src="..."></script>` (with an empty body) becomes `<script>`. `data:`,
  `http(s)://` and `/`-rooted refs are never touched. A missing entry file **throws**; a **missing sibling
  silently leaves its tag as-is** — so a typo in a `href` fails quietly, producing an unstyled page rather
  than an error. Check your filenames.
- **`web.open(html)`** is the single-string alternative. Use `openFile` for anything with more than a few
  lines of CSS.
- **`web.setState(state)`** is a **full replace**, JSON-serialized. Call it whenever state changes. It is
  the per-frame channel: send the small, fast-changing data here and keep the document static. State is
  **retained and replayed automatically to a viewer who arrives later** — you do not need to detect new
  viewers.
- **`web.close()`** blanks every viewer. It also happens automatically when the script stops.
- Only **one** app document per computer; `open`/`openFile` replaces whatever was open.

### Page side

Silica injects `window.mc` **before** your scripts run. It has exactly **four** public members:

```ts
mc.display   // string  which surface this is: a pad's label/id, "pocket", "screen", "computer", or "view"
mc.player    // string  the local viewer's player name
mc.onState   // assign a function; Silica calls it with each state snapshot. Initially null.
mc.send(m)   // → void  send to the server script. An object is JSON.stringify'd; a string is sent as-is.
```

There is no `mc.state`, no `mc.onOpen`, no `mc.ready`, no `mc.call`. Do not invent one.

```js
(function () {
  const mc = window.mc;                        // provided by Silica before this script runs
  const countEl = document.getElementById("count");

  mc.onState = function (state) {              // render whatever the server says
    if (state && typeof state.count === "number") { countEl.textContent = state.count; }
  };

  document.getElementById("inc").addEventListener("click", function () {
    mc.send({ action: "inc" });                // ask; do not decide
  });
})();
```

`mc.display` and `mc.player` are how **one app serves many surfaces** — a pad, a wall screen and a pocket
computer can each render the same document differently. Both can be empty on some surfaces, so filter
before joining them into a label.

### Message direction, precisely

- **page → server**: `mc.send(m)` → an `os.pullEvent("web_message")` event whose **`data` is the raw JSON
  string**. Parse it yourself.
- **server → page**: `web.setState(obj)` → `mc.onState(obj)` on every viewer, with the object already
  deserialized. There is no other channel and no request/response.

**Server-side source tagging.** If the page sent an **object**, the server additively adds a `source`
member before your script sees it:

```js
const msg = JSON.parse(ev.data);
msg.source   // { kind, id, label, player }
             // kind: "computer" | "screen" | "pad" | "pocket" | "view"
             // label / player may be null
```

The server **always overwrites** a page-supplied `source` — identity is the server's word, never the page's.
A bare string, number or array payload passes through **untagged**: there is nowhere additive to put it. So
send objects, always.

### The page is a pure view

- **No client-local timers, no `Math.random()`, no page-local variables that affect what is displayed.** Two
  viewers of the same screen must see the same thing, and state is server-authoritative.
- Keep the document static and put everything that changes in `setState`.
- **The page cannot fetch anything at runtime.** The document is loaded into the browser as a single
  `data:` URL and every non-Silica origin is denied at the browser level (`http(s)`, `file`, `ftp` — all
  blocked). No CDN scripts, no web fonts, no remote images, no `fetch`, no `XMLHttpRequest`. Inline all CSS
  and JS as siblings; embed any image as a `data:` URI, or draw it in CSS.
- **The page cannot show item icons.** The embedded browser cannot reach the game's texture atlas. Use a
  generated colour swatch, a letter, or the item's name — and be honest that it is not a sprite. (Only Path
  A's `gfx.sprite` draws real item icons.)

### Size limits — name the knob, never the number

Every Path-B limit is a **server config knob** whose value differs per world. Do not size a UI against a
number copied out of a document; stale figures in this project have caused real defects three times.

| what | knob | section |
|---|---|---|
| the app **document** (`web.open` / `web.openFile`) | `appDocMaxChars` | `[display]` |
| one `web.setState` **snapshot** | `appStateMaxChars` | `[display]` |
| retained `gfx` draw commands | `gfxMaxCommands` | `[display]` |
| one `network.send` payload | `netMessageMaxBytes` | `[networking]` |
| one disk's saved data | `fsMaxBytes` | `[memory]` |
| slots `items.list()` will walk | `itemsMaxSlots` | `[memory]` |
| the event queue | `eventQueueMax` | `[memory]` |

Overrunning `appDocMaxChars` or `appStateMaxChars` **throws a catchable script error** naming the knob and
its current value — which is the way to find out the real number if you need it. **65,535 and 256 KB are
retired figures; never size a UI against either.** In your own comments, write *"bounded by
`appStateMaxChars`"*, not a digit.

Practical guidance instead of a number: publish a **bounded** state — cap your row lists (the shipped apps
use 60 rows, 12 filter chips, 200 detail fields), aggregate server-side rather than shipping raw slots, and
never put a whole component tree on the wire unflattened.

---

## 11. Designing a UI that actually renders

**This section exists because one CSS mistake shipped five times in this mod.** Read all of it before you
write a stylesheet.

### The viewport is small, and it is not a browser window

| surface | default pixels | input your page receives |
|---|---|---|
| **wall Screen block** | **512 × 384** (`browserResolution` wide, height = ¾ of it) | **one left click. Nothing else.** |
| **wall Pad face** | **512 × 512** (square — the pad face is 1×1) | **one left click. Nothing else.** |
| computer GUI (incl. a pocket computer) | a fixed GUI region, larger | press + release with the **real** button — so left/right/middle reach the page. Still **no** wheel, keyboard, drag or hover |
| the SilicaOS desktop / Runner view window | the Minecraft window | full: wheel, keyboard, drag, mouse-move |

`browserResolution` is a **per-client** setting (range 128–2048, default **512**, so 128 × 96 up to
2048 × 1536), and you cannot know what any given player has set. **Design for 512 × 384 and one click.**
Everything larger then works for free; the reverse is not true, and a layout tuned for a desktop viewport is
silently unreadable or entirely off-screen on a wall. Below about 192 px tall nothing is usable at all,
whatever the styling.

### The input vocabulary of a wall screen is one click

An in-world Screen block or Pad face forwards an **empty-hand right-click** as a single browser
`mousePress` + `mouseRelease` at one point, **left button (index 0)** — a Minecraft right-click arrives as a
browser *left* click. That is the complete list. There is **no** wheel, **no** keyboard, **no** mouse-move,
**no** hover, **no** drag, no double-click, no right-click, no touch. A pad face is byte-for-byte identical
to a wall screen here — it is **not** a richer surface.

Wheel and keyboard exist only for the **trusted SilicaOS desktop** (a smart computer's own full-window GUI,
and the Runner's view window inside it). They never reach an app document on any in-world surface. So
**never require them.**

Therefore, on a wall screen:

- **A scrollable region is unreachable.** No `overflow: scroll`, no scrollbars, no "scroll for more".
- **A text input is unreachable.** No `<input type="text">`, no search box, no typing anything.
- **`:hover` styling is invisible and hover-only affordances are dead.** Tooltips that appear on hover
  cannot be seen. `:active` is fine (press and release both arrive).
- **Drag, sliders and range inputs are unreachable.** `<input type="range">` needs a drag.

Build with **buttons only**:

- Paging instead of scrolling: `▲` / `▼` buttons and a `3/7` position readout. This is the only "scrolling"
  that works on every surface.
- **Chips instead of a search box.** Derive the filter options from the data you already have (the shipped
  `stock-display` builds its tag chips from the tags the inventory's contents actually carry — no hardcoded
  item ids anywhere) and offer them as buttons.
- Steppers (`◀` / `▶`) instead of a slider; a cycle button instead of a dropdown.
- Tap targets sized in `rem` against the clamped root (below), not shrunk to px — the bound is *tap*, not
  legibility.
- **Never let a control become unreachable at 512 × 384.** Drop readouts on a short viewport if you must;
  never drop a control.

### The bug that shipped five times

```css
/* ✗ WRONG — the clamp is DEAD. Every rem renders at ~2× intended and the sheet overflows the screen. */
html { font-size: clamp(6.5px, 1.9vmin, 13.5px); }
html, body { margin: 0; font: 1rem/1.35 var(--mono); }
```

The `font:` shorthand **also sets `font-size`**, and its selector names `html`, so it re-sets the root
*after* the clamp. On the root element `1rem` resolves against `font-size`'s **initial** value of 16px (CSS
Values 4 §5.1.1) — not against the clamp above it. The knob is inert. Measured: computed root font-size
16px instead of 7.3px, 71 boxes clipping their own content, 52 labels truncated to ellipsis, the header
alone eating a third of the screen.

**The rule, positively stated — this is the house pattern, copy it exactly:**

```css
/* ✓ RIGHT — the clamp comes AFTER any `font:` shorthand that targets html. */
html, body {
  margin: 0; height: 100%; overflow: hidden;
  background: var(--paper); color: var(--ink);
  font: 1rem/1.35 var(--mono);
}
/* THE single scaling knob — and it has to come AFTER the `font:` shorthand above. `font:1rem/1.35` also
   sets font-size, and on the ROOT element `1rem` resolves against font-size's INITIAL value (16px, CSS
   Values 4 §5.1.1), so a clamp written before the shorthand is silently overridden and the sheet stops
   scaling entirely — it then lays out at a 16px root and overflows a 512x384 wall screen. */
html { font-size: clamp(6.5px, 1.9vmin, 13.5px); }
```

Scoping the shorthand to `body` alone is the other valid fix. Either is fine; **doing neither is the bug.**

### Checkable layout rules

1. **One viewport-derived root, and everything sized in `rem` off it.** That is what makes the whole sheet
   scale as a unit from a 512 × 384 wall to a full-window pocket render.
2. **Put the clamp after the `font:` shorthand** (above). Then verify by reading the cascade in order: is
   there any later rule whose selector *subject* is `html` or `:root` that sets `font-size` or uses the
   `font:` shorthand? If yes, it wins, and your clamp is dead.
3. **`html, body { height: 100%; overflow: hidden; }`** and lay out with grid/flex. The page must never
   scroll, because scrolling is unreachable.
4. **Every flex/grid item in a column that holds a list needs `min-height: 0`** (and `min-width: 0` in a
   row). Without it, a column flex item's automatic minimum is its *content*, so a column holding a 25-row
   list refuses to shrink and pushes everything below it out of the clipping ancestor — the second half of
   the five-times bug. `min-height: 0` / `min-width: 0` on every `flex: 1` box is cheap insurance.
5. **Clip labels deliberately.** One utility class with
   `white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;` on every label that can
   outgrow its cell. **Exempt the caveats** — an error message, an alarm or a "this reading is partial"
   footnote must wrap and be readable in full. A warning you cannot finish reading is not a warning.
6. **System fonts only.** `system-ui`, `ui-monospace`, `monospace` and named local families. No web fonts:
   nothing can be fetched.
7. **No external assets at all.** No images, no icons, no CDN. `data:` URIs or CSS-drawn shapes.
8. **Both a populated and an empty state.** Design against realistic data — a 27-item inventory, a
   5-generator grid — not an empty shell, or you will not see it overflow.
9. **Show the offline/no-signal case as its own full-sheet card**, shown *instead of* the board, never over
   a stale one. `unloaded = offline` is a Silica invariant and it happens constantly.
10. **Say when a reading is partial.** `summary().scanned < summary().slots`, `GeoStatus.partial`,
    `detail().truncated`, `LaserGateStatus.truncated` — surface each as a visible state, not a silent field.

If the player can run it, tell them to check it at their real wall size, and that the knob is
`browserResolution`.

---

## 12. Worked example — a terminal script

**One file.** An energy gauge with a low-power alarm and hysteresis. Every call is verified API; the shape
(probe → resolve → read → act → draw → sleep) is the one the shipped starter scripts use.

`energy-alarm.js`:

```js
// energy-alarm.js — an energy gauge with a low-power alarm.
//
// WHAT   Watches one networked device's energy buffer, shows a gauge on the screen, and powers a
//        redstone face when the charge falls to LOW_PCT — releasing it only once the charge climbs
//        back above CLEAR_PCT. That gap is the point: a buffer hovering on a single threshold would
//        switch your backup generator on and off several times a second.
// NEEDS  A NIC, and a wired device whose faculties include "energy" (a Port on an energy cube or a
//        machine, a Powercell, a Turret). A GPU is optional — without one it is redstone + terminal.
// SETUP  Screwdriver-label the device, put that label in TARGET, and wire the backup generator (or a
//        lamp, or a siren) to ALARM_SIDE of THIS computer.
// TWEAK  TARGET, LOW_PCT, CLEAR_PCT, ALARM_SIDE, ALARM_LEVEL, POLL_SEC.

const TARGET = "battery";      // screwdriver label (or device id) of the thing to watch
const LOW_PCT = 20;            // alarm switches ON at or below this percentage
const CLEAR_PCT = 40;          // ...and OFF again only at or above this one
const ALARM_SIDE = "down";     // face of THIS computer that carries the alarm
const ALARM_LEVEL = 15;        // level to drive while alarmed, 0-15
const POLL_SEC = 2;            // seconds between readings

// A capability door you lack is a stub that THROWS on every access, so the only honest way to ask is
// to try it and catch. A missing part then costs a feature instead of killing the script.
function probe(fn) { try { fn(); return true; } catch (e) { return false; } }
const HAS_GFX = probe(function () { gfx.width(); });
const HAS_NET = probe(function () { network.devices(); });
const HAS_RS = probe(function () { redstone.getInput(ALARM_SIDE); });

if (!HAS_NET) {
  print("energy-alarm: no network card. Install a NIC to reach '" + TARGET + "'.");
  while (true) { os.pullEvent(); }   // park rather than crash: the message stays readable
}

function fmt(n) {
  return n >= 1000000 ? (n / 1000000).toFixed(1) + "M"
      : (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)));
}

// Resolve and read in one go, and never throw: every failure comes back as a reason string, so a chunk
// unloading under the target degrades to a message instead of killing the alarm. Resolved fresh every
// poll, so swapping the block mid-game just works.
function read() {
  const d = network.find(TARGET);
  if (!d) { return { why: "no device labelled '" + TARGET + "' on the network" }; }
  if (!d.online) { return { why: "'" + TARGET + "' is offline (chunk unloaded or block gone)" }; }
  // faculties, not online: energy() is a Port/receiver facet and throws "device offline" on any other
  // kind of device even while it is loaded and healthy.
  if (d.faculties.indexOf("energy") < 0) {
    return { why: "'" + TARGET + "' has no energy buffer (can: " + d.faculties.join(", ") + ")" };
  }
  try {
    const e = d.energy();
    if (!e || e.capacity <= 0) { return { why: "'" + TARGET + "' reports a zero capacity" }; }
    return { ok: true, stored: e.stored, capacity: e.capacity, pct: e.stored * 100 / e.capacity };
  } catch (err) {
    return { why: String(err) };
  }
}

// Redraw the whole canvas every frame, starting with clear(): the display list is retained, and past
// its cap every further draw is silently DISCARDED until the next gfx.clear().
function draw(r, alarm) {
  if (!HAS_GFX) { return; }
  const W = gfx.width();
  gfx.clear(0x0b1020);
  gfx.rect(0, 0, W, 20, alarm ? 0xff6b6b : 0x5fd08a);
  gfx.text(8, 6, "POWER - " + TARGET, 0x0b1020);
  if (!r.ok) {
    gfx.text(10, 46, "no reading", 0xff6b6b);
    gfx.text(10, 64, r.why.length > 34 ? r.why.substring(0, 33) + "~" : r.why, 0x8a93a6);
    return;
  }
  const pct = Math.round(r.pct);
  const barW = W - 40;
  gfx.rect(20, 56, barW, 22, 0x1c2540);
  gfx.rect(20, 56, Math.round(barW * Math.min(pct, 100) / 100), 22, alarm ? 0xff6b6b : 0x5fd08a);
  gfx.vLine(20 + Math.round(barW * LOW_PCT / 100), 50, 34, 0xff6b6b);     // the alarm threshold
  gfx.vLine(20 + Math.round(barW * CLEAR_PCT / 100), 50, 34, 0xffd166);   // the release threshold
  gfx.text(20, 32, pct + "%", 0xd7e0ee);
  gfx.text(20, 96, fmt(r.stored) + " / " + fmt(r.capacity) + " FE", 0xd7e0ee);
  gfx.text(20, 120, alarm ? "ALARM - " + ALARM_SIDE + " is live" : "ok", alarm ? 0xff6b6b : 0x5fd08a);
  gfx.text(20, 144, "alarm at " + LOW_PCT + "%, clears at " + CLEAR_PCT + "%", 0x8a93a6);
}

print("energy-alarm: watching '" + TARGET + "'. Alarm on " + ALARM_SIDE + " at " + LOW_PCT
    + "%, clears at " + CLEAR_PCT + "%, reading every " + POLL_SEC + "s.");
if (CLEAR_PCT < LOW_PCT) {
  print("energy-alarm: CLEAR_PCT is below LOW_PCT — the alarm will chatter. Raise it above " + LOW_PCT + ".");
}
if (!HAS_GFX) { print("energy-alarm: no GPU, so no screen gauge — the alarm still works."); }
if (!HAS_RS) { print("energy-alarm: the redstone door is closed, so the alarm is display-only."); }

let alarm = false;
let lastWhy = "";

// The server's own clock. os.sleep parks off the compute budget, so this loop is idle between readings
// rather than spinning — and it keeps working with no player anywhere near.
while (true) {
  const r = read();

  if (r.ok) {
    lastWhy = "";
    if (!alarm && r.pct <= LOW_PCT) {
      alarm = true;
      print("energy-alarm: ALARM — '" + TARGET + "' down to " + Math.round(r.pct) + "%.");
    } else if (alarm && r.pct >= CLEAR_PCT) {
      alarm = false;
      print("energy-alarm: clear — '" + TARGET + "' back up to " + Math.round(r.pct) + "%.");
    }
  } else {
    if (r.why !== lastWhy) { lastWhy = r.why; print("energy-alarm: cannot read — " + r.why); }
    alarm = true;   // a gauge that goes quiet when its target vanishes is a trap
  }

  if (HAS_RS) { redstone.setOutput(ALARM_SIDE, alarm ? ALARM_LEVEL : 0); }
  draw(r, alarm);
  os.sleep(POLL_SEC);
}
```

---

## 13. Worked example — a minimal app

**Four files.** A redstone control panel: it shows the live input level on one face and lets a viewer drive
another face on or off. It needs **no NIC** — only `web` and `redstone` — so it is the smallest app that is
still useful, and it demonstrates the timed server-clock loop, message validation, and the 512 × 384
stylesheet pattern.

### `redstone-panel/entrypoint.js`

```js
// redstone-panel/entrypoint.js — server-side entry for the Redstone Panel (multi-file Path B).
//
// ALL capability access is here on the server. The page holds no authority: it asks with mc.send, and
// this script validates the request and answers with an authoritative snapshot.
//
// Capability doors: web (needs the web-display jar) + redstone.

const IN_SIDE = "north";    // the face whose incoming level is displayed
const OUT_SIDE = "south";   // the face the buttons drive
const LEVEL = 15;           // level driven while ON, 0-15
const SWEEP_MS = 500;       // how often the server re-reads the input face

// --- the server clock: WHY THIS APP DOES NOT WAIT ON THE PAGE ---
// web_message is posted only by a packet from a VIEWING player's browser. With the untimed
// os.pullEvent("web_message") this loop would advance once per viewer poll — so the readout would
// freeze when nobody is looking, and five viewers would cost five times the reads. The timed form
// returns null on timeout, which lets the loop keep a clock of its own:
//   * exactly ONE input read per SWEEP_MS, however many people are watching;
//   * a click is answered the moment it arrives.
let nextSweepMs = 0;
let on = false;            // server-held, so every viewer of this panel sees the same state
let level = 0;             // the last reading of IN_SIDE

// Re-arm from NOW — never `nextSweepMs += SWEEP_MS`. After a lag spike the next cycle is simply late;
// it never queues a catch-up burst.
function markSwept() { nextSweepMs = Date.now() + SWEEP_MS; }

// Whatever is LEFT on the deadline, so an arriving message does not restart the clock. Capped so a
// backwards clock jump can't park for hours; floored at 0. pullEvent rounds any value up to one whole
// game tick, so this loop can never busy-spin.
function waitSeconds() {
  let left = nextSweepMs - Date.now();
  if (left > SWEEP_MS) { left = SWEEP_MS; }
  if (left < 0) { left = 0; }
  return left / 1000;
}

// Never throw out of the read: the redstone door can be welded shut server-wide, and a panel that
// dies is worse than one that says so.
function readInput() {
  try { return { ok: true, level: redstone.getInput(IN_SIDE) }; }
  catch (e) { return { ok: false, reason: String(e) }; }
}

function apply() {
  try {
    redstone.setOutput(OUT_SIDE, on ? LEVEL : 0);
    return "";
  } catch (e) {
    return String(e);
  }
}

let fault = "";

function publish() {
  web.setState({
    ok: fault === "",
    reason: fault,
    inSide: IN_SIDE,
    outSide: OUT_SIDE,
    level: level,       // 0-15 incoming on IN_SIDE
    on: on,             // whether this script is driving OUT_SIDE
    out: on ? LEVEL : 0
  });
}

function sweep() {
  const r = readInput();
  if (r.ok) { level = r.level; fault = ""; } else { fault = r.reason; }
  publish();
}

web.openFile("ui/index.html");   // resolves relative to this app's own folder
fault = apply();                 // put the output in a known state before anyone looks at it
sweep();
markSwept();

while (true) {
  // null on timeout. NOT a plain pullEvent: with nobody watching, no web_message is ever produced.
  const ev = os.pullEvent("web_message", waitSeconds());

  if (ev) {
    // ev.data is the RAW JSON STRING the page sent. Parse it, and treat it as untrusted input.
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch (e) { msg = null; }

    switch (msg && msg.action) {       // an allowlist of three actions; everything else is ignored
      case "on":     on = true;  fault = apply(); break;
      case "off":    on = false; fault = apply(); break;
      case "toggle": on = !on;   fault = apply(); break;
      default:       break;            // includes the page's plain "poll" heartbeat
    }
    publish();                         // answer from cache — a poll costs no capability call at all
  }

  // The clock tick: the fresh read, whether or not anyone is watching.
  if (!ev || Date.now() >= nextSweepMs) {
    sweep();
    markSwept();
  }
}
```

### `redstone-panel/ui/index.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redstone Panel</title>
<!-- Siblings, inlined into one document by web.openFile. A typo in either href fails SILENTLY. -->
<link rel="stylesheet" href="style.css">
</head>
<body>

<!-- The no-signal card: shown INSTEAD of the panel, never over a stale one. It starts lit, so the first
     thing a viewer sees is "connecting" rather than a board full of dashes. -->
<div class="offsheet on" id="offsheet"><div class="off-card">
  <div class="off-mark">REDSTONE<b>//</b>PANEL</div>
  <div class="off-tag">No signal</div>
  <!-- deliberately NOT ellipsis-clipped: a fault you cannot finish reading is not a fault -->
  <div class="off-reason" id="offReason">Waiting for the server...</div>
</div></div>

<div class="sheet">

  <div class="rule">
    <div class="mark">REDSTONE<b>//</b>PANEL</div>
    <div class="spacer"></div>
    <div class="meta"><span class="link"><span class="dot"></span><span>LINK LIVE</span></span></div>
  </div>

  <div class="board">

    <section class="node in">
      <div class="n-head"><span class="n-tag">IN</span><span class="n-name" id="inSide">-</span></div>
      <div class="n-body">
        <div class="read">
          <div class="lbl">Incoming level</div>
          <div class="big"><b id="lvl">-</b><span class="unit">/15</span></div>
        </div>
        <div class="gauge"><div class="track"><div class="fill" id="fill"></div></div></div>
      </div>
    </section>

    <section class="node out">
      <div class="n-head"><span class="n-tag">OUT</span><span class="n-name" id="outSide">-</span>
        <span class="n-state idle" id="state"><span class="lamp"></span><span id="stateTxt">-</span></span></div>
      <div class="n-body">
        <div class="read">
          <div class="lbl">Driving</div>
          <div class="big"><b id="out">-</b><span class="unit">/15</span></div>
        </div>
        <!-- Buttons only. A wall screen forwards one click and nothing else: no wheel, no keyboard,
             no hover, no drag — so no slider, no text box, no scrolling. -->
        <div class="row">
          <button class="btn" type="button" id="bOn">ON</button>
          <button class="btn ghost" type="button" id="bToggle">TOGGLE</button>
          <button class="btn" type="button" id="bOff">OFF</button>
        </div>
      </div>
    </section>

  </div>

  <div class="foot"><span class="st-lamp" id="stLamp"></span><span class="st-txt" id="stTxt">Standing by...</span></div>

</div>

<script src="client.js"></script>
</body>
</html>
```

### `redstone-panel/ui/style.css`

```css
/* REDSTONE PANEL — fixed, non-scrolling, every dimension in rem off ONE viewport-derived root, so the
   sheet scales as a unit from a 512x384 wall screen up to a full-window pocket render. System fonts
   only, no assets, nothing to load, no external anything (nothing CAN be fetched). */
:root{
  --paper:#080a0e;
  --ink:#efe6d2;
  --dim:rgba(239,230,210,.5);
  --faint:rgba(239,230,210,.13);
  --live:#3fe0c2;
  --hot:#ff5b49;
  --warn:#f4b63b;
  --mono:"SFMono-Regular","Consolas","Roboto Mono",ui-monospace,"Liberation Mono",monospace;
}
*{box-sizing:border-box;}
html,body{margin:0;height:100%;overflow:hidden;background:var(--paper);color:var(--ink);
  font:1rem/1.35 var(--mono);-webkit-user-select:none;user-select:none;}
/* THE single scaling knob — and it has to come AFTER the `font:` shorthand above. `font:1rem/1.35` also
   sets font-size, and on the ROOT element `1rem` resolves against font-size's INITIAL value (16px, CSS
   Values 4 §5.1.1), so a clamp written before the shorthand is silently overridden and the sheet stops
   scaling entirely — it then lays out at a 16px root and overflows a 512x384 wall screen. */
html{font-size:clamp(6.5px,1.9vmin,13.5px);}
button{font-family:var(--mono);}

/* min-height:0 on every flex/grid child that can hold growing content: without it a column item's
   automatic minimum is its CONTENT, so it refuses to shrink and pushes the rest off the screen. */
.sheet{height:100%;display:grid;grid-template-rows:auto 1fr auto;gap:.65rem;padding:.9rem 1rem;min-height:0;}
.rule{display:flex;align-items:flex-end;gap:1.1rem;border-bottom:1px solid var(--faint);
  padding-bottom:.55rem;min-width:0;}
.mark{font-size:1.75rem;line-height:.9;letter-spacing:.15rem;text-transform:uppercase;white-space:nowrap;}
.mark b{color:var(--live);font-weight:inherit;}
.spacer{flex:1;min-width:0;}
.meta{display:flex;align-items:center;gap:1.2rem;font-size:.82rem;text-transform:uppercase;color:var(--dim);}
.link{display:flex;align-items:center;gap:.5rem;color:var(--live);}
.lamp,.dot,.st-lamp{width:.62rem;height:.62rem;border-radius:50%;background:currentColor;
  box-shadow:0 0 .6rem currentColor;flex:none;}
.dot{animation:blink 1.6s ease-in-out infinite;}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}

.board{min-height:0;min-width:0;overflow:hidden;display:grid;grid-template-columns:1fr 1fr;gap:.6rem;}
.node{position:relative;display:flex;flex-direction:column;padding:.85rem .9rem;min-width:0;min-height:0;
  border:1px solid var(--faint);background:rgba(11,14,20,.92);overflow:hidden;}
.node.in{--ac:var(--live);}
.node.out{--ac:var(--warn);}
.node.out.live{--ac:var(--hot);}
.n-head{display:flex;align-items:baseline;gap:.65rem;border-bottom:1px dashed var(--faint);
  padding-bottom:.45rem;margin-bottom:.5rem;flex:none;min-width:0;}
.n-tag{font-size:.8rem;color:var(--ac);border:1px solid var(--ac);padding:0 .4rem;flex:none;}
.n-name{font-size:1.35rem;letter-spacing:.1rem;text-transform:uppercase;flex:1;}
.n-state{font-size:.76rem;letter-spacing:.12rem;text-transform:uppercase;display:flex;align-items:center;
  gap:.4rem;color:var(--dim);flex:none;}
.n-state.live{color:var(--hot);}
.n-body{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:.8rem;}
.read .lbl{font-size:.76rem;letter-spacing:.14rem;text-transform:uppercase;color:var(--dim);}
.read .big{font-size:3.4rem;line-height:1;font-variant-numeric:tabular-nums;}
.read .big b{color:var(--ac);font-weight:700;}
.read .big .unit{font-size:1rem;color:var(--dim);margin-left:.35rem;}
.gauge .track{height:.9rem;border:1px solid var(--faint);background:rgba(0,0,0,.5);}
.gauge .fill{height:100%;width:0;background:var(--ac);transition:width .12s linear;}

/* Tap targets sized in rem against the (live) clamped root, never shrunk to px: the bound is TAP, not
   legibility. :active works on a wall screen — press and release both arrive. :hover does not. */
.row{display:flex;gap:.6rem;}
.btn{flex:1;padding:.85rem 0;font-size:1rem;font-weight:700;letter-spacing:.1rem;color:var(--paper);
  background:var(--ac);border:none;cursor:pointer;min-height:2.6rem;}
.btn.ghost{flex:0 0 auto;padding:.85rem 1rem;color:var(--dim);background:transparent;border:1px solid var(--faint);}
.btn:active{transform:translateY(1px);}

.foot{display:flex;align-items:center;gap:.6rem;border-top:1px solid var(--faint);padding-top:.5rem;
  font-size:.8rem;color:var(--dim);min-width:0;}
/* the ONE truncation utility — and .st-txt is in it because it is a status line, not a fault */
.st-txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}

/* the no-signal sheet: shown INSTEAD of the board */
.offsheet{position:fixed;inset:0;z-index:80;display:none;place-items:center;background:var(--paper);padding:1.5rem;}
.offsheet.on{display:grid;}
.off-card{max-width:32rem;text-align:center;}
.off-mark{font-size:1.9rem;letter-spacing:.15rem;text-transform:uppercase;}
.off-mark b{color:var(--hot);font-weight:inherit;}
.off-tag{margin-top:.4rem;font-size:.85rem;letter-spacing:.2rem;text-transform:uppercase;color:var(--hot);}
/* deliberately NOT clipped: a fault you cannot finish reading is not a fault */
.off-reason{margin-top:.9rem;font-size:.95rem;line-height:1.5;color:var(--dim);}
```

### `redstone-panel/ui/client.js`

```js
// redstone-panel/ui/client.js — the page side.
// The bridge Silica injects before this file runs:
//   mc.onState = fn   <- the server pushed new state (from web.setState)
//   mc.send(msg)      -> ask the server to do something; it validates and acts
//   mc.display        -> "screen" | "computer" | "pocket" | "view" | a pad's label
//   mc.player         -> the local viewer's name
//
// The page holds NO authority and NO state of its own. Buttons only REQUEST; the readouts change only
// when authoritative state comes back down. That is what keeps every viewer of this panel identical.

(function () {
  const mc = window.mc;
  const el = function (id) { return document.getElementById(id); };

  const offsheet = el("offsheet"), offReason = el("offReason");
  const nodeOut = document.querySelector(".node.out");

  mc.onState = function (s) {
    if (!s) { return; }

    if (!s.ok) {
      offReason.textContent = s.reason || "The server reported a fault.";
      offsheet.classList.add("on");
      return;
    }
    offsheet.classList.remove("on");

    el("inSide").textContent = s.inSide;
    el("outSide").textContent = s.outSide;
    el("lvl").textContent = s.level;
    el("out").textContent = s.out;
    el("fill").style.width = Math.round(s.level * 100 / 15) + "%";

    nodeOut.classList.toggle("live", !!s.on);
    el("state").className = "n-state " + (s.on ? "live" : "idle");
    el("stateTxt").textContent = s.on ? "LIVE" : "OFF";
    el("stLamp").style.color = s.on ? "var(--hot)" : "var(--dim)";

    // Both identity fields can be empty on some surfaces — filter, or the line reads "undefined".
    const who = [mc.display, mc.player].filter(function (x) { return x; }).join(" · ");
    el("stTxt").textContent = (s.on ? "Driving " + s.outSide : "Idle") + (who ? "  ·  " + who : "");
  };

  function ask(action) { return function () { mc.send({ action: action }); }; }
  el("bOn").addEventListener("click", ask("on"));
  el("bOff").addEventListener("click", ask("off"));
  el("bToggle").addEventListener("click", ask("toggle"));
})();
```

### `redstone-panel/silica.json` (only if submitting to the catalog)

```json
{
  "id": "redstone-panel",
  "title": "Redstone Panel",
  "summary": "Read one face's redstone level and drive another, from a screen or a pad",
  "kind": "app",
  "category": "redstone",
  "author": "your-name",
  "needs": {
    "doors": ["web", "redstone"],
    "parts": ["gpu"]
  }
}
```

---

## 14. Submitting it to the catalog

The player can publish this to the **Silica Store** so it appears in-game. One folder per entry under
`scripts/`, and **the folder name is the entry id** (lowercase letters, digits, hyphens, 1–48 chars).

```
scripts/<entry-id>/
  silica.json     required
  README.md       required — this is what the Store app shows a player
  ...             the code
```

- **`kind: "script"`** — exactly one `.js` at the entry root, and no `ui/` directory. Installs as
  `<entry-id>.js`.
- **`kind: "app"`** — an `entrypoint.js` (or an `index.html`) at the entry root, plus whatever else it
  needs; `ui/` is the convention. Installs as the folder `<entry-id>/`.

`silica.json` requires `id` (equal to the folder name), `title`, `summary` (one line, ≤160 chars), `kind`,
`category` and `author`. `needs.doors` / `needs.parts` / `needs.mods` are optional but you should fill them
in. **Categories are a fixed list:** `starter`, `example`, `redstone`, `storage`, `energy`, `security`,
`automation`, `monitoring`, `mining`, `other`.

- **List every door the code may call**, whether or not it can manage without it. A Path-B app with an HTML
  interface uses **`web`**, not `gfx` — but it still declares the **`gpu`** part, because SilicaOS needs one.
- **`parts`** is only what the player must genuinely have: `gpu`, `hdd`, `nic`. A script that draws an
  optional canvas touches the `gfx` **door** and does not require the `gpu` **part**.
- **`needs` is disclosure, not enforcement.** Doors are server-wide settings; declaring fewer does not
  restrict your code, it just misleads the player. That is the deceptive case, and it gets an entry rejected.
- **Never edit `index.json`** — CI generates it.

The full field reference, the structural limits and the exact `needs` semantics are in this repository's
[README.md](README.md); the submission process, the honesty rules and licensing are in
[CONTRIBUTING.md](CONTRIBUTING.md). Validate before opening a pull request:

```
node tools/build-index.mjs --check
```

Write the entry `README.md` for a player who has not seen the code: what it does, what hardware and blocks
it needs, how to set it up, and which settings they are meant to change. The renderer supports headings,
paragraphs, lists, tables, fenced code and inline `code`/`**bold**`/`*italic*`. **Images are not rendered
and links are inert text.**

Contributions are MIT-licensed by opening the pull request, and review is by a human who reads the code.

---

## 15. Self-check before you answer

Verify every line. Any "no" means fix it before answering.

**API**
- [ ] Every global I used is one of: `print`, `os`, `redstone`, `gfx`, `fs`, `network`, `pads`, `web`.
- [ ] Every method, argument name and returned field appears in §5 of this file. I invented nothing.
- [ ] I did not use `require`, `import`, `export`, `fetch`, `setTimeout`, `setInterval`, `console`,
      `async`/`await`, `process`, or any Java/host call.
- [ ] I did not read `device.energy()`, `device.redstone` or `device.fluids` on anything but a Port/receiver.
- [ ] I tested `device.faculties`, not just `device.online`, before every faculty call.
- [ ] I used `device.call(verb, argsObject)` for peripheral verbs, with verbs from the tables in §5.
- [ ] `turret.fire`/`aim` get **all three** of `{x, y, z}` or none — never `{target}`, never a partial pair.
- [ ] `card_swipe` has no `player` field (it is `{reader, card, tier, accepted}`). `analyzer.scan()` returns
      one object, not a list. `geo.veins()` is nearest-first. `device.faculties` can contain `"peripheral"`.
- [ ] I did not expect `mouse_click` from a wall screen, or `gfx.sprite` to render on one.

**Execution**
- [ ] Every `while` loop contains `os.sleep` or `os.pullEvent`. None can spin.
- [ ] No control, alarm or interlock loop waits on an untimed `os.pullEvent("web_message")`,
      `"mouse_click"` or `"pad_touch"`.
- [ ] Any loop that must work with nobody present uses `os.pullEvent(filter, seconds)` or `os.sleep`, and
      re-arms its deadline from `Date.now()` rather than accumulating.
- [ ] I used `os.pullEvent("redstone")` rather than `os.sleep` wherever an edge must not be missed.
- [ ] Anything that must survive a restart is written with `fs`, and I said a hard drive is needed.

**Robustness**
- [ ] Every capability I touch is probed with try/catch, and the script **degrades with a printed reason**
      instead of throwing.
- [ ] If a required door is shut, the script prints why and parks — it does not crash.
- [ ] `items.summary()` and `items.list()` are in **separate** try blocks.
- [ ] I guard `maxDamage`/`capacity` before dividing by them.
- [ ] `network.find` results are checked for `null`, and re-resolved rather than cached forever.
- [ ] Peripheral polling is slow (~1 s or slower); `items.detail()` is driven by a click, never a timer.

**Path B (skip if terminal-only)**
- [ ] `entrypoint.js` holds **all** state and **all** capability access. The page holds none.
- [ ] `ev.data` is `JSON.parse`d inside a try/catch, and actions are matched against an **allowlist**.
- [ ] `web.openFile("ui/index.html")` is called once; sibling `href`/`src` filenames match the real files
      exactly.
- [ ] `web.setState` is called after every state change, and the state is bounded (capped row counts).
- [ ] `client.js` uses only `mc.onState`, `mc.send`, `mc.display`, `mc.player` — nothing else on `mc`.
- [ ] No external asset, font, image, CDN or `fetch` anywhere in the page. No item sprites.
- [ ] No client-local timer, `Math.random()`, or page-local variable that changes what is displayed.
- [ ] I named the config knob (`appStateMaxChars`, `appDocMaxChars`) in comments instead of a number.

**UI (skip if terminal-only)**
- [ ] The stylesheet's `html { font-size: clamp(...) }` comes **after** every `font:` shorthand whose
      selector subject is `html` — or the shorthand is scoped to `body` alone. **Re-read the cascade to
      confirm.**
- [ ] `html, body { height: 100%; overflow: hidden; }` and the page never scrolls.
- [ ] Every `flex: 1` / grid child that can hold growing content has `min-height: 0` (and `min-width: 0` in
      a row).
- [ ] Every dimension is in `rem` off that one clamped root — no px layout sizes.
- [ ] It fits **512 × 384** with every control fully visible and hit-testable.
- [ ] There is **no** scrollable region, text input, slider, `<input type="range">`, dropdown, drag or
      hover-only affordance. Paging is `▲`/`▼` buttons; filtering is chips.
- [ ] There is a populated state, an empty state and a full-sheet no-signal card.
- [ ] Fault, alarm and "partial reading" text wraps and is never ellipsis-clipped.

**Delivery**
- [ ] I gave complete files with their paths, not fragments.
- [ ] I said which doors and which parts the player needs, and which constants they should edit.
- [ ] I named anything I was unsure about rather than guessing an API for it.
