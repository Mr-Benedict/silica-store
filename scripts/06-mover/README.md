# 06-mover — an item mover between two networked inventories

Moves items from one labelled device into another, either on a timer or on a redstone pulse, optionally
only one item id. The move is **simulate-then-execute**, so it can never dupe or void, and it reports how
many items actually went.

## What it needs

1. A **NIC**. Without one it says so and parks.
2. Two wired devices whose `faculties` include `items` — a Port on a chest or a machine, a Collector, an
   Ejector, a Turret's magazine.
3. Screwdriver-label the source and the destination, and put those names in `FROM` and `TO`. In
   `"redstone"` mode, pulse `TRIGGER_SIDE` of this computer to move one batch.

## Settings

| constant | default | what it does |
|---|---|---|
| `FROM` | `"input"` | label (or id) of the device to take items out of |
| `TO` | `"output"` | label (or id) of the device to put them into |
| `MODE` | `"timer"` | `"timer"` = every `PERIOD_SEC`; `"redstone"` = one batch per pulse |
| `PERIOD_SEC` | `5` | timer mode only |
| `TRIGGER_SIDE` | `"north"` | redstone mode only: pulse this face |
| `ITEM` | `""` | `""` = move anything; else one id, e.g. `"minecraft:iron_ingot"` |
| `BATCH` | `0` | `0` = as much as fits; else the most items to move per run |

## Notes

Both labels are resolved fresh on every run, so swapping the chest mid-game just works and an unloaded
chunk is a message rather than a crash.

In `"redstone"` mode only the rising edge fires, so a lever left on does not move items forever, and it
waits on `os.pullEvent("redstone")` rather than sleeping — `os.sleep` discards events, and a dropped button
press is a batch that never moved. A pulse always reports what happened, even when nothing moved, because
you asked; an idle timer stays quiet and reports only when items actually move.
