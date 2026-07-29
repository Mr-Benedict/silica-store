# 04-devices — the network browser

Lists every device this computer can reach — label, id, kind, online, faculties — plus the energy buffer
and inventory of the ones that have them. It re-reads on a timer and prints **only when something
changed**, so it can be left running while you build: new blocks appear on the list as you wire them in.

With a GPU it also draws the first eight devices as a panel, with the first stack of each inventory as a
sprite.

## What it needs

1. A **network card (NIC)**. Without one it says so and parks, rather than crashing.
2. Something to find. A device is reachable if it is face-adjacent to this computer, wired to it, or
   across a Router → Receiver pair.
3. Label your blocks with a screwdriver. That label is the name every other script in this suite uses to
   address a device.

## Settings

| constant | default | what it does |
|---|---|---|
| `REFRESH_SEC` | `5` | how often to re-read the network |
| `KIND` | `""` | `""` = every kind; else only this one, e.g. `"detector"` or `"port"` |
| `SHOW_DETAIL` | `true` | also read energy + inventory (one extra call per device that has one) |
| `ROW_CAP` | `16` | most rows to print at once |

## Notes

Every faculty read is wrapped in its own `try`: a chunk can unload between listing a device and calling
it, and an unreadable device should cost you one line, not the whole script. Remember the Silica invariant
— **unloaded = offline**, which is why an offline row reads *offline (chunk unloaded or block gone)*
instead of vanishing.

The table is printed only when the picture actually differs from last time. A browser left running that
reprinted every `REFRESH_SEC` would bury everything else in an endless identical list.
