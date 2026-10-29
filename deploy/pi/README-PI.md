# Apartment15 on a Raspberry Pi with openHAB

Runs the Node map server next to openHAB so tablets stay on your LAN (offline-capable).

## Quick deploy from your Mac

```bash
cd /path/to/apartment15-map
# ensure deploy/pi/apartment15.env has A15_OPENHAB_TOKEN
export PI_USER=openhabian          # or pi
export PI_PASS='your-pi-password'
./deploy/pi/push-to-pi.sh
```

This rsyncs the project to the Pi, installs Node if needed, enables `apartment15.service`, and points the MainUI page iframes at `http://192.168.1.100:8765/…`.

## Manual install (on the Pi)

```bash
# after copying the project to /tmp/apartment15-deploy (or clone)
cd /tmp/apartment15-deploy
sudo bash deploy/pi/install-on-pi.sh
```

Env ends up in `/etc/apartment15.env` with:

- `A15_PUBLIC_URL=http://192.168.1.100:8765`
- `A15_OPENHAB_URL=http://127.0.0.1:8080`
- your API token

## URLs (after install)

| What | URL |
|------|-----|
| CAD | http://192.168.1.100:8765/ |
| 3D | http://192.168.1.100:8765/preview3d.html?model=mdl_b446edcaf7&view=1 |
| openHAB page | http://192.168.1.100:8080/page/apartment15_map |

## openHAB Items

Already creatable via REST from the Mac; or copy export pack `openhab/apartment15.items` into `/etc/openhab/items/`.

In the 3D HUD, enable **openHAB sync**.

## Troubleshooting

| Symptom | Check |
|---------|--------|
| Blank iframe in MainUI | `systemctl status apartment15`; `curl http://127.0.0.1:8765/api/health` on Pi |
| status `configured: false` | Token in `/etc/apartment15.env`; `sudo systemctl restart apartment15` |
| Permission denied writing models | `sudo chown -R openhab:openhab /opt/apartment15` |
| SSH from Mac fails | Set `PI_USER` / `PI_PASS`, or add your `~/.ssh/id_rsa.pub` to the Pi `authorized_keys` |
