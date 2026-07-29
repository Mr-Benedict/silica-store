# 05-power — an energy gauge with a low-power alarm

Watches one device's energy buffer, draws a gauge, and powers a redstone face when the charge falls to
`LOW_PCT` — releasing it only once the charge climbs back above `CLEAR_PCT`. That gap is the whole point:
a buffer hovering on a single threshold would switch your backup generator on and off several times a
second.

## What it needs

1. A **NIC**. Without one it says so and parks.
2. A wired device with an energy buffer — a Port on an energy cube or a machine, a Powercell, a Turret:
   anything whose `faculties` include `energy`.
3. Screwdriver-label that device, put the label in `TARGET`, and wire the backup generator (or a lamp, or
   a siren) to `ALARM_SIDE` of **this** computer.

## Settings

| constant | default | what it does |
|---|---|---|
| `TARGET` | `"battery"` | screwdriver label (or device id) of the thing to watch |
| `LOW_PCT` | `20` | alarm switches **on** at or below this percentage |
| `CLEAR_PCT` | `40` | …and off again only at or above this one |
| `ALARM_SIDE` | `"down"` | face of **this** computer that carries the alarm |
| `ALARM_LEVEL` | `15` | level to drive while alarmed, 0–15 |
| `POLL_SEC` | `2` | seconds between readings |
| `ALARM_ON_LOST` | `true` | treat "cannot read the device" as an alarm too |
| `LOG_EVERY` | `30` | print the charge every N readings; `0` = only on a change |

## Notes

Reading never throws: every failure comes back as a reason string, so a chunk unloading under the target
degrades to a message instead of killing the alarm. With `ALARM_ON_LOST` on, an unreadable target counts as
an alarm — a gauge that goes quiet when the thing it watches vanishes is a trap.

Setting `CLEAR_PCT` below `LOW_PCT` is called out at startup, because it makes the alarm chatter. If the
`redstone` door is shut the script still runs as a display-only gauge and says so.

The two thresholds are drawn on the gauge as tick lines, so you can see how wide your hysteresis gap
actually is.
