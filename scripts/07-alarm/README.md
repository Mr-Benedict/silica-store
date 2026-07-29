# 07-alarm — a proximity alarm driven by an Entity Detector

Reads an **Entity Detector** on this computer's own clock and powers a redstone face while something you
care about is inside `TRIP_DIST`, holding the line for `HOLD_SEC` after the last contact leaves so it
cannot chatter as a mob walks back and forth over the line.

With a GPU it draws a radar dish centred on the Detector, with the contacts plotted on it — red for
hostile, blue for a player, green for anything else — and the nearest five listed by name and distance.

This is the terminal version of the `detector` app, which watches the same block with a full web UI.

## What it needs

1. A **NIC** and an **Entity Detector** wired to this computer. Without a NIC it says so and parks.
2. Label the Detector with a screwdriver and put that label in `DETECTOR`; `""` uses the first Detector
   found on the network.
3. Wire whatever you want triggered to `ALARM_SIDE` of **this** computer.

The server's `detector` peripheral capability must also be enabled — it is by default.

## Settings

| constant | default | what it does |
|---|---|---|
| `DETECTOR` | `""` | label or id of the Detector; `""` = the first one on the network |
| `WATCH` | `"hostile"` | what counts as a contact: `"hostile"` \| `"player"` \| `"any"` |
| `TRIP_DIST` | `8` | blocks: a contact closer than this trips the alarm |
| `HOLD_SEC` | `5` | keep the line hot this long after the last contact leaves |
| `ALARM_SIDE` | `"down"` | face of **this** computer that carries the alarm |
| `POLL_SEC` | `1` | seconds between reads (the block scans on its own clock anyway) |

## Notes

There is one config read at startup, and it earns its keep twice: it gives the radar its outer edge, and it
catches the trap where the **block's own** filter can never report the thing you armed the alarm against —
an empty Detector filter matches nothing and will never trip, and the script says so.

Sweeping never throws; a missing, unloaded or unreadable Detector comes back as a reason string instead of
killing the alarm. `HOLD_SEC` is converted to whole polls, minimum one, so a hold shorter than `POLL_SEC`
still lasts a sweep. If the redstone face cannot be driven the script keeps running as a display.
