# 🏠 layout-map

A browser-based **floor-plan CAD editor with a 3D preview**, built to plan an apartment and wire the plan up to a smart home. Draw walls, rooms, doors and windows, drop in furniture and devices from a catalog, walk through the result in 3D, and sync devices with **openHAB** on a **Raspberry Pi**.

> Built by [Faisal Shafi](https://github.com/vtoxi) as a home-automation side project (Pi, ESP32 and friends). It started as a personal tool, so expect rough edges. Issues and PRs are welcome.

## ✨ Features

- **2D CAD editor** with grid and snapping, layers, walls, rooms, openings, furniture and device placement
- **Furniture catalog** across 13 categories (seating, sleep, kitchen, bath, lighting, storage and more)
- **3D preview and walkthrough** (three.js), plus a read-only share view
- **Area schedule** export (CSV) and a full export pack (zip)
- **openHAB bridge:** generates items for your devices and syncs state in the 3D view
- **Tuya support** through openHAB (helper script in `deploy/pi`)
- **Two backends with the same API:** a Node server (`server.mjs`) for a Pi or laptop, and a PHP mirror (`api.php` + `web.config`) for Windows/IIS hosting
- Optional login (off by default) for shared deployments

## 🚀 Run it locally

Requires Node.js 18 or newer.

```bash
git clone https://github.com/vtoxi/layout-map.git
cd layout-map
node server.mjs
```

Open http://127.0.0.1:8765/ for the editor and http://127.0.0.1:8765/preview3d.html for the 3D view. Data is stored in the `models/` and `data/` folders, which are gitignored.

### Configuration

Set these environment variables before starting the server:

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Server port | `8765` |
| `A15_PUBLIC_URL` | URL tablets and iframes use to reach the server | `http://127.0.0.1:<PORT>` |
| `A15_OPENHAB_URL` | openHAB REST address | `http://127.0.0.1:8080` |
| `A15_OPENHAB_TOKEN` | openHAB API token (MainUI, then profile, then Create API Token) | empty (sync off) |
| `A15_AUTH` | Set to `1` to require login for changes | off |
| `A15_CORS` | Allowed CORS origin | `*` |
| `A15_FRAME_ANCESTORS` | Origins allowed to embed the app (for openHAB MainUI) | local openHAB origins |

## 🍓 Deploy on a Raspberry Pi with openHAB

See [`deploy/pi/README-PI.md`](deploy/pi/README-PI.md). In short: copy `deploy/pi/apartment15.env.example` to `deploy/pi/apartment15.env`, add your openHAB token, then run `deploy/pi/push-to-pi.sh`. It installs Node and a systemd service on the Pi. The example files use `192.168.1.100` as the Pi's address, so change that to yours.

## 🌐 Deploy to IIS/Plesk hosting (optional)

Copy `.deploy.env.example` to `.deploy.env`, fill in your own FTP details, then run `./deploy.sh` (needs `lftp`). `.deploy.env` is gitignored.

## 🔒 Security notes

- Auth is **off by default**, so anyone who can reach the server can edit models. Keep it on your LAN or set `A15_AUTH=1`.
- Never commit `.env` files or API tokens. The repo ignores them by default.

## 🤝 Contributing

Bug reports and pull requests are welcome. For bigger changes, open an issue first.

## 📄 License

[MIT](LICENSE) © Faisal Shafi

---

If this is useful, you can [buy me a coffee](https://buymeacoffee.com/faisalshafi) ☕ or [get in touch](mailto:faisalshafi69@gmail.com?subject=layout-map) about a project.
