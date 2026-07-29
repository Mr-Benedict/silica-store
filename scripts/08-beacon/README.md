# 08-beacon — two computers talking to each other

Broadcasts a numbered heartbeat every `PERIOD_SEC`, listens for everyone else's, and powers a redstone face
while at least one partner is alive — a link light for a remote base, or a dead-man's switch for a machine
that must not run alone. The beat counter is written to disk, so a restart carries on instead of starting
over.

With a GPU it shows this beacon's name, its beat count, and up to six peers with each one's last beat and
how long ago it arrived.

## What it needs

1. A **NIC**. Without one it says so and parks.
2. A **second computer running this same script** on the same network — adjacent, through a Switch, or
   across a Router → Receiver pair. A broadcast never comes back to its sender, so one beacon alone sees no
   peers, forever.
3. A different `NAME` on each computer, and a lamp on `LINK_SIDE` if you want the link light.
4. A **hard drive** is optional. Without one the counter simply restarts at zero.

## Settings

| constant | default | what it does |
|---|---|---|
| `NAME` | `"beacon-a"` | what this computer calls itself; make it different on each one |
| `PERIOD_SEC` | `5` | seconds between heartbeats |
| `TIMEOUT_SEC` | `15` | a partner unheard for this long counts as lost |
| `LINK_SIDE` | `"down"` | face of **this** computer that is live while a partner is alive |
| `SEND_TO` | `""` | `""` = broadcast to every computer; else one computer's label/id |
| `LOG_BEATS` | `true` | print every heartbeat received, not just arrivals and losses |

## Notes

The loop waits with the **timed** form, `os.pullEvent("net_message", wait)`, and never past its own next
send. That is what lets a single loop both listen and keep a clock: the call returns the event, or `null`
when the time is up.

A message can come from any script on any computer, so the payload's shape is checked before it is
trusted — anything that is not a `heartbeat` is ignored. Peers are tracked by sender device id, not by
name, so two computers that share a `NAME` still count as two.
