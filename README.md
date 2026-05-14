# Nitro Imager V3 — Installation Guide

Server-side avatar renderer for Habbo-style retro hotels. Generates PNG / GIF images of avatars on demand via HTTP URL (e.g. `/imaging/?figure=ha-1003-88...&action=std&direction=2&size=l`).

This setup runs inside a Docker container, behind nginx, and reuses your existing gamedata (no file duplication).

---

## 1. Prerequisites

Before starting, make sure the host machine has:

| Requirement                  | Why                                                                  |
| ---------------------------- | -------------------------------------------------------------------- |
| **Linux** (Debian 12+ / Ubuntu 22.04+)                            | Tested on Debian 13 trixie and Ubuntu 24 LTS. Animated GIF support is unlocked by the fix in §7. |
| **Docker Engine + Compose v2 plugin**                             | Container runtime                                                 |
| **nginx** running on the host                                      | Reverse proxy in front of the container                           |
| **Gamedata already on disk** (FigureData.json, FigureMap.json, HabboAvatarActions.json, EffectMap.json + `.nitro` files for clothes/effects) | The imager loads these at startup |
| ~2 GB free disk space        | Docker image, node\_modules, build artifacts                       |

### 1.1 Install Docker (if missing)

Debian / Ubuntu — official Docker repo:

```bash
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Adjust 'debian' / codename if you run Ubuntu (use ubuntu / jammy / noble / etc.)
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Verify
docker --version
docker compose version
```

---

## 2. Layout of this folder

```
Nitro_Imager_V3/
├── Dockerfile                     ← node:22-slim base + canvas native libs (LTS — Node 23 is rejected by eslint-visitor-keys)
├── docker-compose.yml             ← container definition (loopback bind, RO mount)
├── README.md                      ← you are reading this
└── imager/
    ├── .env                       ← runtime paths (point to your gamedata)
    ├── package.json               ← node deps (canvas, gifencoder, express)
    ├── tsconfig.json
    ├── index.ts
    ├── config.json
    └── src/
        ├── router/
        │   └── HttpRouter.ts      ← GIF encoder fix already applied (see §7)
        └── ...
```

---

## 3. Configuration

### 3.1 `imager/.env`

Edit each `AVATAR_*` variable to match the actual location of your gamedata **on the host**. Inside the container these paths must resolve through the bind mount (default: host `/var/www` → container `/var/www`).

Example layout (adapt the paths to where your CMS / client stores gamedata):

```env
API_HOST=0.0.0.0
API_PORT=3030
IMAGER_PATH='/imaging'
AVATAR_SAVE_PATH=/src/saved_figure

AVATAR_ACTIONS_URL=/var/www/your-cms/public/nitro-assets/gamedata/HabboAvatarActions.json
AVATAR_FIGUREDATA_URL=/var/www/your-cms/public/nitro-assets/gamedata/FigureData.json
AVATAR_FIGUREMAP_URL=/var/www/your-cms/public/nitro-assets/gamedata/FigureMap.json
AVATAR_EFFECTMAP_URL=/var/www/your-cms/public/nitro-assets/gamedata/EffectMap.json

AVATAR_ASSET_URL=/var/www/your-cms/public/nitro-assets/bundled/figure/%libname%.nitro
AVATAR_ASSET_EFFECT_URL=/var/www/your-cms/public/nitro-assets/bundled/effect/%libname%.nitro
```

Change **only** the `AVATAR_*` paths to match your setup. Do **not** remove `%libname%` from the asset URLs — the imager substitutes it at runtime.

`AVATAR_SAVE_PATH=/src/saved_figure` is the **in-container** cache directory. On the host it maps to `Nitro_Imager_V3/imager/saved_figure/` (created automatically on first run).

### 3.2 `docker-compose.yml`

Key choices baked into this file:

| Setting                                        | Why                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `ports: - "127.0.0.1:3030:3030"`               | Loopback-only. Container is NOT reachable from outside the host. nginx proxies. |
| `volumes: /var/www:/var/www:ro`                | Gamedata mounted **read-only** — the container cannot accidentally modify it.   |
| `volumes: ./imager:/src`                       | Source folder is the working dir. Lets you edit code on host, rebuild on restart. |
| `command: sh -c "yarn install && yarn build && yarn start"` | First boot installs deps + compiles TS + starts. Subsequent boots reuse cached deps. |
| `restart: always`                              | Survives reboot.                                                                |
| Private bridge `172.38.0.0/24`, container IP `172.38.0.2` | Reserved for future direct-IP proxying; not used right now.                   |

If you change the bind port (`127.0.0.1:3030`) update the nginx `proxy_pass` accordingly.

---

## 4. Deploy to the server

Copy this whole folder to the host. Suggested destination path: `/docker/nitro_imager/`.

From a Windows workstation (PowerShell):

```powershell
scp -r -i $HOME\.ssh\your_ssh_key `
  C:\path\to\Nitro_Imager_V3\* `
  root@YOUR-HOST:/docker/nitro_imager/
```

From Linux / macOS:

```bash
rsync -av --delete \
  ./Nitro_Imager_V3/ \
  root@YOUR-HOST:/docker/nitro_imager/
```

Make sure permissions are sane on the host:

```bash
mkdir -p /docker/nitro_imager
chown -R root:root /docker/nitro_imager
```

---

## 5. Build and start the container

```bash
cd /docker/nitro_imager
docker compose up -d --build
```

What happens on the first run:

1. `docker compose` builds the image from `Dockerfile` (downloads `node:22-slim`, installs `libcairo`, `libpango`, `libjpeg`, `libgif`, build tools — about 4–5 minutes the first time). Node 22 LTS is the safe choice — do **not** revert to Node 23 (odd-numbered, non-LTS, `eslint-visitor-keys@5` rejects it during `yarn install`).
2. Container starts, mounts `./imager` → `/src`.
3. `yarn install` downloads node deps inside the container (`canvas`, `express`, `gifencoder`, …). This compiles native bindings — needs ~2–3 minutes.
4. `yarn build` runs `tsc` to compile TypeScript into `dist/`.
5. `yarn start` runs `node ./dist/index.js`. The imager scans every clothing/effect `.nitro` file referenced by `FigureMap.json` and `EffectMap.json` to validate access.

Watch logs:

```bash
docker logs -f habbo_imager
```

Expected end-of-boot output:

```
[Nitro] Starting Nitro Imager
[Nitro] Loading: /var/www/.../bundled/figure/hh_human_body.nitro
[Nitro] Loading: /var/www/.../bundled/figure/hh_human_item.nitro
[Nitro] Loading: /var/www/.../bundled/effect/Dance1.nitro
…
[Nitro] Server Started 0.0.0.0:3030
```

If you see `ENOENT` errors, an `AVATAR_*` path in `.env` is wrong — fix it, then `docker compose restart`.

---

## 6. Nginx integration

Add this `location` block inside the `server { listen 443 ssl; ... }` block of your hostname, before the catch-all `location /`:

```nginx
location /imaging/ {
    proxy_pass http://127.0.0.1:3030/;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60;
}
```

> ⚠️ The trailing slash on **both** `location /imaging/` and `proxy_pass http://…:3030/` matters. The container's express router is mounted at `/imaging` internally, so nginx strips its prefix and passes the rest. Mismatching slashes will cause 404 on every avatar URL.

Test and reload:

```bash
nginx -t && systemctl reload nginx
```

---

## 7. The GIF flicker fix (applied)

`src/router/HttpRouter.ts` has been patched to remove three sources of flicker in animated GIFs:

| Original                                | Patched                                | Reason                                                                            |
| --------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------- |
| `encoder.setTransparent(0xfefefe)`       | `encoder.setTransparent(0xff00ff)`     | Off-white is too close to anti-aliased pixels — quantizer drops it and bleeds. Pure magenta never appears in avatar art. |
| `encoder.setDelay(110)`                 | `encoder.setDelay(80)`                 | 110 ms feels sluggish; 80 ms matches Habbo's native ~12.5 fps.                    |
| `encoder.setQuality(1)`                 | `encoder.setQuality(10)`               | Quality 1 (max) is brittle with the magenta-key trick; 10 is the default sweet spot. |
| (none — missing)                        | `encoder.setDispose(2)`                | "Restore to background" — without this, each frame retains the previous one underneath → ghost / flicker. |

If you tweak speed: `setDelay()` is in milliseconds. Match it against the action's `frame_speed` from `HabboAvatarActions.json` if you want strict accuracy.

---

## 8. Testing

Open in a browser (replace `YOUR_DOMAIN`):

```
https://YOUR_DOMAIN/imaging/?figure=ha-1003-88.lg-285-89.ch-3032-1334-109.sh-3016-110.hd-180-1359&action=std&gesture=sml&direction=2&head_direction=2&img_format=png&size=l
```

You should see a PNG avatar render. For an animated test:

```
https://YOUR_DOMAIN/imaging/?figure=hr-100-7.hd-180-1.ch-210-66.lg-270-82.sh-290-80&action=dance.1&direction=2&head_direction=2&img_format=gif&size=l
```

You should see a smoothly looping GIF, **without flicker** thanks to §7.

### Useful query parameters

| Param           | Values                                                          | Example                          |
| --------------- | --------------------------------------------------------------- | -------------------------------- |
| `figure`        | Habbo figure string                                              | `hr-100-7.hd-180-1.ch-210-66…`  |
| `direction`     | `0`–`7`                                                          | `direction=2`                   |
| `head_direction`| `0`–`7`                                                          | `head_direction=2`              |
| `action`        | `std`, `wlk`, `lay`, `sit`, `wav`, `dance.1`..`dance.4`         | `action=wav`                    |
| `gesture`       | `sml` (smile), `sad`, `srp` (surprise), `agr`, `eyb`, `spk`     | `gesture=sml`                   |
| `size`          | `s`, `m`, `l`                                                    | `size=l`                        |
| `img_format`    | `png`, `gif`                                                     | `img_format=gif`                |
| `headonly`      | `0` / `1`                                                        | `headonly=1`                    |
| `frame_num`     | integer (specific animation frame, PNG only)                    | `frame_num=3`                   |

---

## 9. Day-to-day operation

```bash
# Status
docker ps --filter name=habbo_imager

# Tail logs
docker logs -f habbo_imager

# Restart (e.g. after editing .env)
docker compose restart

# Stop / start
docker compose stop
docker compose start

# Apply code changes to src/
# Edit on host, then:
docker compose restart   # yarn build re-runs at boot

# Force full rebuild of node_modules (rare)
docker compose down
rm -rf imager/node_modules
docker compose up -d --build

# Clear the on-disk render cache (after avatar art changes)
rm -rf imager/saved_figure/*
```

---

## 10. Troubleshooting

| Symptom                                                | Cause / fix                                                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 404 on every `/imaging/...` URL                        | Trailing-slash mismatch in nginx (`location /imaging/` vs `proxy_pass http://…:3030/`). See §6.       |
| 502 Bad Gateway                                        | Container not running, or it crashed during boot. `docker logs habbo_imager`.                        |
| `Error: ENOENT … FigureData.json`                      | `AVATAR_FIGUREDATA_URL` path is wrong, or `/var/www` is not bind-mounted. Check `.env`.              |
| `Error loading clothes/X.nitro`                        | `FigureMap.json` references a `.nitro` file that does not exist on disk. Either add the file, or live with the warning — the imager only fails per-figure, not globally. |
| GIF still flickering                                   | Cache hit on a pre-fix GIF. `rm -rf imager/saved_figure/*` and retry.                                |
| All avatars come back grey / faceless                  | `FigureData.json` palette / set ids are out of sync with the `.nitro` art. Regenerate gamedata.       |
| Container exits immediately, no useful log              | Probably `yarn install` failing for native canvas build. Check `docker logs habbo_imager` — usually missing `libcairo2-dev`. The Dockerfile already installs these; if you customized it, restore the apt-get section. |
| Very high CPU on every request                         | First-time rendering of a figure is expensive (parses every `.nitro`). After cache fills, response is instant. Pre-warm by hitting common avatar URLs. |

---

## 11. Security notes

- Port `3030` is bound to `127.0.0.1` — **never expose it to the public internet** even via UFW or firewall rules. nginx is the only intended entry point.
- `/var/www` is mounted read-only — even a code RCE inside the container cannot tamper with hotel assets.
- The container runs as root by default. If you want to harden further, add `user: "1000:1000"` to `docker-compose.yml` and `chown -R 1000:1000 imager/saved_figure`.
- Filename matching on Linux is **case-sensitive**: `Dance1.nitro` ≠ `dance1.nitro`. Bad casing in `FigureMap.json` will give silent 404s.

---

## 12. Updating

To pull upstream code changes (preserving your `.env` and `saved_figure/` cache):

```bash
cd /docker/nitro_imager
git stash                            # if the folder is a git checkout
git pull                              # or rsync new sources
git stash pop                         # restore your .env + docker-compose.yml
docker compose up -d --build
```

If `package.json` changed:

```bash
rm -rf imager/node_modules            # force fresh install
docker compose up -d --build
```

---

## 13. Reference

- Complete retro setup (full installation guide for your hotel): <https://github.com/duckietm/Complete-Retro-on-Ubuntu>
- Nitro client (V3): <https://github.com/duckietm/Nitro-V3>
- Nitro renderer (V3): <https://github.com/duckietm/Nitro_Render_V3>
- GIFEncoder docs (node-canvas-gif fork): <https://www.npmjs.com/package/gifencoder>

---

## Credits

Made by **medievalshell** — <https://github.com/medievalshell>
