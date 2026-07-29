# counter — the hello-world of Path B

The smallest complete Path-B app there is: a number, three buttons, and nothing else. It touches **no
device, no network, no redstone** — only `web`. Read it first.

Needs a computer with **web-display** and a GPU. Nothing else. Run it from the Runner and view it on
the computer, a screen, a pad or a pocket.

## Why it is this small

It exists to show the whole bridge in one screen, and that bridge is four calls:

| where | call | what it is |
|---|---|---|
| `entrypoint.js` | `web.openFile("ui/index.html")` | serve this app's own `ui/` folder over `silica://` |
| `entrypoint.js` | `web.setState({count})` | push authoritative state down to every viewer |
| `ui/client.js` | `mc.onState = fn` | the page receives that state and renders it |
| `ui/client.js` | `mc.send({action})` | the page **asks**; it never decides |

That is the entire contract. `detector` is 822 lines of the same four calls with a real device behind
them, which is exactly why it is the wrong file to start on.

The one rule worth taking away: **the count lives on the server.** The buttons do not change the
number — they request a change, `entrypoint.js` validates the message (`JSON.parse` in a try/catch, an
allowlist of three actions, everything else ignored) and pushes the new count back. Every viewer sees
the same value because there is only one value. Client messages are untrusted input; this app treats
them that way even though its worst case is an off-by-one.

## Why it has no clock

Its loop uses the **untimed** `os.pullEvent("web_message")` — and that is correct here, not an
oversight. The app owns no device and does no work between clicks, so there is nothing for a clock to
drive; state is retained and replayed to a new viewer automatically. An app that reads a peripheral
needs the timed form instead (`collector`, `ejector`, `detector` all use it and say why in their run
loops).
