# 03-latch — a redstone toggle

A pulse in flips an output that **stays** flipped until the next pulse — a T flip-flop, in software. One
button turns a lamp, a door or a farm on; the same button turns it off again. Building that out of vanilla
redstone takes a chest-load of parts and a lot of floor space.

## What it needs

1. Nothing beyond a working computer.
2. A button, lever or pressure plate wired to `IN_SIDE`, and whatever you want toggled wired to
   `OUT_SIDE`. A button or plate is the natural fit: one press, one flip. A lever works, but only
   switching it **on** counts, so it takes two throws to get one flip.
3. A **hard drive** is optional. With one, and `REMEMBER` left on, the latch comes back the same way after
   a restart instead of coming back off.

## Settings

| constant | default | what it does |
|---|---|---|
| `IN_SIDE` | `"north"` | pulse this face to flip the latch |
| `OUT_SIDE` | `"south"` | this face holds the latched state |
| `LEVEL` | `15` | output level while latched on, 0–15 |
| `REMEMBER` | `true` | save the state to disk so a restart comes back the same way |

## Notes

Only the **rising** edge counts, so holding a lever down is one flip and not thousands: the script
remembers what the face looked like last time and acts only when it goes from cold to hot.

It waits on `os.pullEvent("redstone")` rather than sleeping, because `os.sleep` **discards** whatever
arrives while it is parked — a button press during the nap would be lost. The event fires for a change on
*any* face, which is why `IN_SIDE` is still re-read and compared.

The saved state is keyed by output face (`03-latch.<OUT_SIDE>`), so two latches on one computer do not
overwrite each other.
