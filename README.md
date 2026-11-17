# SWARM OS — networked edition

**Live:** https://hyperion-strategies.github.io/swarmOS/ · open **Veil** from the dock, or go straight to [`#veil`](https://hyperion-strategies.github.io/swarmOS/#veil).

SWARM OS is a desktop operating system in one HTML file: a window manager, a virtual filesystem and 15 apps. Claude Opus 5.5 wrote the kernel and shell, and 11 Claude Fable 5.2 agents built 11 of the apps in parallel. The Hive app shows who wrote what.

This branch is the edition that can use the network. It is the same OS plus **Veil**, a private browser built in layers.

## Veil's layers

| Layer | What it does |
|---|---|
| Route | Requests leave through **Nym → Tor** (Tor circuits built inside the Nym mixnet), **Tor** alone, or **Nym** alone. There is no code path to a direct connection, and a failed route stays failed. |
| Content | Pages are parsed inertly and stripped of scripts, frames and plugins. They render in a sandboxed frame whose policy only allows `data:` resources, so nothing on a page can reach the network itself. |
| Identity | Each site gets its own Tor circuit and exit. Every user sends the same headers, no cookies are kept, and "New identity" (or a timer) rotates every circuit. |
| Checks | The exit IP each site sees is fetched through that site's own circuit and shown, with Tor exits confirmed by check.torproject.org. |

On the **Nym → Tor** route, the path is: you → Nym entry gateway → 3 mix layers → Nym exit → Wisp relay → Tor guard → middle → exit → site. Nym never learns where you go, and Tor never learns who you are.

## Honest limits

- **Not audited.** It is experimental software.
- **No site JavaScript.** Pages that need scripts won't work, and sites behind bot challenges may refuse Tor and Nym exits.
- **Third-party relays.** The chained route depends on a public Wisp relay (`wisp.mercurywork.shop`). The Tor-only route depends on the tor-js demo gateway, which has limited capacity. Both can be swapped for self-hosted ones through `window.__VEIL_CONFIG__`.
- **Slow first page.** On Nym → Tor it can take minutes, because Tor bootstraps through the mixnet.
- **MAC addresses** never leave your local network, so no website can see them. Operating systems already randomize them per Wi-Fi network.

## Libraries

These are served from this site, pinned, with no CDN at runtime. Hashes are in [`net/vendor/VENDOR.md`](net/vendor/VENDOR.md).

- [tor-js](https://github.com/ethereum/tor-js): Arti, the Tor Project's Rust client, compiled to WebAssembly.
- [@nymproject/mix-tunnel and mix-websocket](https://github.com/nymtech/nym): Nym's mixnet client in WebAssembly.
- `net/wisp.js`: a Wisp v1 client that carries Tor relay connections over a WebSocket opened through the mixnet.
