# SWARM OS — networked edition

**Live:** https://hyperion-strategies.github.io/swarmOS/ · open **Veil** from the dock, or go straight to [`#veil`](https://hyperion-strategies.github.io/swarmOS/#veil).

SWARM OS is a desktop operating system in one HTML file: a window manager, a virtual filesystem and 15 apps. Claude Opus 5.5 wrote the kernel and shell, and 11 Claude Fable 5.2 agents built 11 of the apps in parallel. The Hive app shows who wrote what.

This branch is the edition that can use the network. It is the same OS plus **Veil**, a private browser built in layers.

## Veil's layers

| Layer | What it does |
|---|---|
| Route | Requests leave through **Nym → Tor** (Tor circuits built inside the Nym mixnet), **Tor** alone, or **Nym** alone. There is no code path to a direct connection, and a failed route stays failed. |
| Content | Pages are parsed inertly and stripped of scripts, frames and plugins, then moved into a sandboxed frame as DOM nodes, never re-parsed as HTML. The frame's policy only allows `data:` resources, and Veil closes a page the moment anything in it loads or navigates outside the route. A page-wide policy also stops any frame from navigating to a real address. |
| Identity | On the Tor routes each site gets its own circuit, chosen per redirect hop, so sites behind the same link shortener don't share an exit. The Nym route has one exit for every site. Every user sends the same headers and no cookies are kept. "New identity" resets every window; a timed rotation gives the next page a fresh circuit. |
| Checks | The exit IP each site sees is fetched with that site's isolation key and shown. Tor exits are confirmed by check.torproject.org. |

On the **Nym → Tor** route, the path is: you → Nym entry gateway → 3 mix layers → Nym exit → Wisp relay → Tor guard → middle → exit → site. Nym never learns where you go, and Tor never learns who you are.

## Review

On Nov 19, 2026 a Claude Fable 5.2 agent that had not seen the code reviewed Veil and found 13 problems. Three were critical: a hostile page could slip a real link past the cleaner (a `</style>` inside fetched CSS, an SVG `<set>` animation, a parser-differential trick), and one click would have opened the site directly. Others: the page loaded Google Fonts, redirects shared one circuit, "0 direct" was a fixed label, and the Nym route's claims were too strong. All 13 are addressed. Its attack pages, plus more, now run as Veil's regression tests, both with and without the page-wide policy.

## Honest limits

- **Not audited.** One AI review is not an audit. It is experimental software.
- **Not Tor Browser.** Every Veil user sends the same headers, but the TLS and HTTP fingerprint comes from tor-js (or Nym's client), so a site can tell Veil apart from Tor Browser.
- **The Nym route has no per-site isolation.** It uses one exit per visit, and it resolves names over encrypted DNS (Quad9, Cloudflare or Google) sent through the mixnet.
- **No site JavaScript.** Pages that need scripts won't work, and sites behind bot challenges may refuse Tor and Nym exits.
- **Third-party relays.** The chained route depends on a public Wisp relay (`wisp.mercurywork.shop`). The Tor-only route depends on the tor-js demo gateway, which has limited capacity. Both can be swapped for self-hosted ones through `window.__VEIL_CONFIG__`.
- **Slow first page.** On Nym → Tor it can take minutes, because Tor bootstraps through the mixnet.
- **MAC addresses** never leave your local network, so no website can see them. Operating systems already randomize them per Wi-Fi network.

## Libraries

These are served from this site, pinned, with no CDN at runtime. The fonts are self-hosted too, so loading the page contacts no third party; the only outside connections are a route's entry point (Nym's directory and gateways, or the tor-js gateway) once you open a page. Hashes are in [`net/vendor/VENDOR.md`](net/vendor/VENDOR.md).

- [tor-js](https://github.com/ethereum/tor-js): Arti, the Tor Project's Rust client, compiled to WebAssembly.
- [@nymproject/mix-tunnel and mix-websocket](https://github.com/nymtech/nym): Nym's mixnet client in WebAssembly.
- `net/wisp.js`: a Wisp v1 client that carries Tor relay connections over a WebSocket opened through the mixnet.
