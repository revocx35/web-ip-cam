# Web IP Cam

Turn old phones, tablets and laptops into **RTSP IP cameras** using only a web browser. You don't need to install an app.

1. Deploy the server with Docker Compose.
2. When you open the site for the first time, create the **admin account**.
3. As admin, create **streams**. Each stream has a name and its own password.
4. On an old device, open the site, choose **Log in to stream**, and allow camera and microphone access.
5. The server then publishes that device's camera and microphone as an RTSP stream:

```
rtsp://<stream name>:<stream password>@<server>:8554/<stream name>
```

You can add this URL to Home Assistant, Frigate, Blue Iris, Synology Surveillance Station, VLC, ffmpeg, or any NVR.

## Quick start

Create a folder with this `docker-compose.yml`:

```yaml
services:
  app:
    image: ghcr.io/revocx35/web-ip-cam:latest
    restart: unless-stopped
    depends_on:
      - mediamtx
    ports:
      - "8443:8443"   # web UI (HTTPS - required for camera access)
      - "8080:8080"   # web UI (plain HTTP, e.g. behind a reverse proxy)
    volumes:
      - ./data:/data
    environment:
      RTSP_PUBLIC_PORT: "8554"
      WEBRTC_PUBLIC_PORT: "8189"

  mediamtx:
    image: bluenviron/mediamtx:latest
    restart: unless-stopped
    ports:
      - "8554:8554"          # RTSP
      - "8000:8000/udp"      # RTSP over UDP (RTP)
      - "8001:8001/udp"      # RTSP over UDP (RTCP)
      - "8189:8189/udp"      # WebRTC media from the browser cameras
      - "8189:8189/tcp"      # WebRTC media, TCP fallback
    environment:
      MTX_AUTHMETHOD: http
      MTX_AUTHHTTPADDRESS: http://app:9000/mediamtx/auth
      MTX_API: "yes"
      MTX_WEBRTCLOCALUDPADDRESS: ":8189"
      MTX_WEBRTCLOCALTCPADDRESS: ":8189"
      MTX_RTMP: "no"
      MTX_HLS: "no"
      MTX_SRT: "no"
```

Then:

```bash
docker compose up -d
```

Open **`https://<server-ip>:8443`** and create the admin account.

> **Create the admin account right away.** Until an admin exists, anyone who can reach the site can claim it.

> **About the certificate warning:** browsers only allow camera access on HTTPS pages. On first start, the app generates a self-signed certificate (stored in `./data/certs`). Each device will show a certificate warning once; accept it to continue (on Chrome: *Advanced → Proceed*). If you have your own certificate, see [Configuration](#configuration).

To build from source instead of pulling the image:

```bash
git clone https://github.com/revocx35/web-ip-cam.git
cd web-ip-cam
docker compose up -d --build
```

## Usage

### Admin

- **Create streams:** each stream needs a name (letters, digits, `-`, `_`) and a password. The password is shown once, inside the full RTSP URL, when you create the stream. Passwords are stored as hashes.
- **Monitor streams:** the dashboard shows which streams are live, how long they've been up, how many viewers they have, and their codecs.
- **Change a stream's password:** this disconnects the camera, which must then log in again.
- **Delete a stream:** this disconnects the camera and its viewers.

### Camera device

1. Open `https://<server-ip>:8443` and choose **Log in to stream**.
2. Enter the stream name and password, then allow camera and microphone access. Streaming starts automatically.
3. Optional settings: camera (front/back), resolution, frame rate, bitrate, codec, and whether to stream audio. The device remembers these settings.
4. **Screen off** blacks out the display while streaming continues. Double-tap to wake it.

Tips for old devices:

- Keep the device plugged in, and keep the browser tab open in the foreground. Most mobile browsers stop the camera when the tab is in the background.
- Where the browser supports it, the page asks the device to keep the screen on (Wake Lock). You can also turn off auto-lock in the device settings.
- The device stays logged in (for up to a year), so after a reboot you only need to reopen the page. If the connection drops, the page reconnects automatically.

### Viewing / NVR

```
rtsp://cam1:secret@192.168.1.10:8554/cam1
```

- The RTSP **username is the stream name** and the **password is the stream password**.
- Both RTSP over TCP and RTSP over UDP work.
- **Video:** H.264 by default. It passes through without transcoding, so it uses almost no server CPU. VP8 is also available in the camera settings.
- **Audio:** Opus, because that's what browsers send. Most modern software handles it (Home Assistant, Frigate/go2rtc, VLC, ffmpeg). If your NVR can't use Opus, turn off audio on the camera page or transcode it with ffmpeg.

## How it works

```
 old phone (browser)                          server (docker compose)                      NVR / VLC
┌────────────────────┐  HTTPS 8443   ┌──────────────────────────────┐
│ getUserMedia       │──────────────▶│ app (Node.js)                │
│ WebRTC (WHIP)      │  SDP offer    │  • admin/stream accounts     │
│                    │               │  • WHIP proxy + auth         │
│                    │               │  • RTSP auth hook  ◀─────────┼──┐
│                    │               └──────────┬───────────────────┘  │ auth
│                    │  media UDP/TCP 8189      │ WHIP                 │
│                    │─────────────────────────▶┌───────────────────┐  │
└────────────────────┘                          │ MediaMTX          │──┘   RTSP 8554
                                                │ WebRTC → RTSP     │─────────────────▶
                                                └───────────────────┘
```

- The **app** serves the UI, stores the accounts, and forwards the browser's WHIP (WebRTC-HTTP ingest) request to MediaMTX. The browser never talks to MediaMTX's HTTP API directly, and only a logged-in stream session can publish.
- **[MediaMTX](https://github.com/bluenviron/mediamtx)** receives the WebRTC media and serves it as RTSP. For every RTSP connection, it asks the app's internal auth endpoint whether to allow it. The app accepts the connection only when the username and password match the stream name and stream password.
- **ICE candidates:** inside Docker, MediaMTX only knows its container IP. To fix this, the app adds the address you used to open the site to the WebRTC answer (for example `192.168.1.10`, or a hostname, which it resolves). In most cases no configuration is needed.

## Configuration

Environment variables for the `app` service:

| Variable | Default | Description |
|---|---|---|
| `HTTPS_PORT` | `8443` | HTTPS port for the web UI (inside the container). |
| `HTTP_PORT` | `8080` | Plain HTTP port. Camera access only works over HTTPS, so use this port only behind a TLS reverse proxy. |
| `HTTPS_ENABLED` | `true` | Set to `false` to serve only HTTP (for example, when a reverse proxy handles TLS). |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | *(empty)* | Paths to your own certificate and key (mount them into the container). If not set, the app uses a self-signed certificate. |
| `TRUST_PROXY` | *(empty)* | Set to `true` (or a hop count or subnet) when running behind a reverse proxy, so that client IPs and hostnames are detected correctly. |
| `RTSP_PUBLIC_HOST` | *(the host you browse with)* | Hostname or IP shown in the RTSP URLs on the admin page. |
| `RTSP_PUBLIC_PORT` | `8554` | RTSP port shown in the RTSP URLs. |
| `WEBRTC_PUBLIC_PORT` | `8189` | Public port of MediaMTX's WebRTC listener. It must match the port mapping of the `mediamtx` service. |
| `WEBRTC_ADDITIONAL_HOSTS` | *(empty)* | Comma-separated extra IPs or hostnames (hostnames are looked up on each connection) to advertise as WebRTC candidates. Examples: your LAN IP when you open the site through a domain, or a DDNS name. |
| `ALLOW_EMBED_FROM` | *(empty)* | Comma-separated origins allowed to show the app in an iframe, for example `https://ha.example.com` for a Home Assistant Webpage card. If empty, embedding is blocked. |
| `WEBRTC_AUTO_CANDIDATE` | `true` | Advertise the address used to open the site as a WebRTC candidate. |
| `MEDIAMTX_API_URL` | `http://mediamtx:9997` | Internal URL of the MediaMTX API. |
| `MEDIAMTX_WEBRTC_URL` | `http://mediamtx:8889` | Internal URL of the MediaMTX WebRTC/WHIP server. |
| `DATA_DIR` | `/data` | Where the database (`db.json`) and certificates are stored. |

For the `mediamtx` service, you can use any [MediaMTX setting](https://github.com/bluenviron/mediamtx/blob/main/mediamtx.yml) as an `MTX_*` environment variable. Don't change the `MTX_AUTH*` settings: the app depends on them for authentication.

### Using your own certificate

```yaml
  app:
    volumes:
      - ./data:/data
      - /etc/letsencrypt/live/cam.example.com:/certs:ro
    environment:
      TLS_CERT_FILE: /certs/fullchain.pem
      TLS_KEY_FILE: /certs/privkey.pem
```

### Behind Nginx Proxy Manager (or another reverse proxy)

The proxy only handles the **web UI**. The camera video (WebRTC) goes directly from the browser to port **8189 UDP/TCP**. RTSP goes directly to port **8554**, because RTSP isn't HTTP.

**1. Compose file.** Turn off the app's own HTTPS and trust the proxy's forwarded headers. If Nginx Proxy Manager runs in Docker on the same host, attach the app to its network so port 8080 doesn't have to be published:

```yaml
services:
  app:
    image: ghcr.io/revocx35/web-ip-cam:latest
    restart: unless-stopped
    depends_on:
      - mediamtx
    volumes:
      - ./data:/data
    environment:
      HTTPS_ENABLED: "false"
      TRUST_PROXY: "true"
      RTSP_PUBLIC_HOST: "192.168.1.10"          # server LAN IP, shown in the RTSP URLs
      WEBRTC_ADDITIONAL_HOSTS: "192.168.1.10"   # lets cameras on the LAN connect directly
    networks:
      - default
      - npm

  mediamtx:
    image: bluenviron/mediamtx:latest
    restart: unless-stopped
    ports:
      - "8554:8554"
      - "8000:8000/udp"
      - "8001:8001/udp"
      - "8189:8189/udp"
      - "8189:8189/tcp"
    environment:
      MTX_AUTHMETHOD: http
      MTX_AUTHHTTPADDRESS: http://app:9000/mediamtx/auth
      MTX_API: "yes"
      MTX_WEBRTCLOCALUDPADDRESS: ":8189"
      MTX_WEBRTCLOCALTCPADDRESS: ":8189"
      MTX_RTMP: "no"
      MTX_HLS: "no"
      MTX_SRT: "no"

networks:
  npm:
    external: true
    name: nginxproxymanager_default   # check the real name with: docker network ls
```

If Nginx Proxy Manager runs on another machine (or you don't want to share a network), leave out the `networks:` parts and publish `"8080:8080"` on `app` instead.

**2. Proxy host in Nginx Proxy Manager.** Go to *Hosts → Proxy Hosts → Add Proxy Host*:

| Field | Value |
|---|---|
| Domain Names | `cam.example.com` |
| Scheme | `http` |
| Forward Hostname / IP | `app` (shared network), or the server's IP |
| Forward Port | `8080` |
| Block Common Exploits | on |
| Websockets Support | not needed |
| SSL tab | Request a Let's Encrypt certificate, turn on **Force SSL** and **HTTP/2** |

You don't need any custom Nginx config.

**3. Make port 8189 reachable.**
- **Cameras on your LAN:** set `WEBRTC_ADDITIONAL_HOSTS` to the server's LAN IP (as above). Then LAN cameras connect directly, even though the domain resolves to your public IP.
- **Cameras outside your LAN (for example a phone on 4G):** forward **8189 UDP and TCP** on your router to the server. The app automatically advertises the IP your domain resolves to. If that isn't your real public IP (for example with the Cloudflare proxy / orange cloud), add your public IP or a DDNS hostname to `WEBRTC_ADDITIONAL_HOSTS`, separated by commas: `"192.168.1.10,myhome.duckdns.org"`.

**4. RTSP.** NVRs on the LAN use `rtsp://…@<server LAN IP>:8554/<name>` directly. Only forward 8554 on your router if you need RTSP from outside, and prefer a VPN for that.

### Home Assistant dashboard (wall tablet / kiosk)

A tablet running a Home Assistant dashboard can be a camera too. Embed the camera page in a **Webpage card**:

1. On the `app` service, allow your Home Assistant origin (the address you open Home Assistant with, without a path):
   ```yaml
       environment:
         ALLOW_EMBED_FROM: "https://ha.yourdomain.com"
   ```
2. Add a Webpage card (YAML mode):
   ```yaml
   type: iframe
   url: https://cam.yourdomain.com/camera?embed=1
   allow: camera; microphone; fullscreen
   aspect_ratio: 16:9
   ```
   `?embed=1` shows just the video with a status badge. Log in to the stream once inside the card.

Requirements and limitations:
- **Home Assistant must be opened over HTTPS.** Browsers block the camera inside an iframe unless the page around it is also HTTPS.
- **Keep Home Assistant and the camera app on the same domain** (for example `ha.yourdomain.com` and `cam.yourdomain.com`). Safari blocks cookies in iframes from other sites, so the login wouldn't stick.
- The camera only runs **while the card is on screen**. Switching to another dashboard view, or the screen turning off, stops it; it reconnects automatically when the card is shown again. For a continuous stream, put the card on the view the kiosk normally shows.

### Ports

| Port | Protocol | Purpose |
|---|---|---|
| 8443 | TCP | Web UI (HTTPS) |
| 8080 | TCP | Web UI (HTTP, for reverse proxies) |
| 8554 | TCP | RTSP |
| 8000–8001 | UDP | RTSP over UDP |
| 8189 | UDP + TCP | WebRTC media from the cameras |

## Troubleshooting

- **The camera page says "Camera access requires HTTPS".** Open the site with `https://…:8443`, not `http://`.
- **The camera page stays on "connecting" or "reconnecting".** The browser can't reach port **8189** on the server. Check that the port is open in your firewall. If you open the site through a hostname that resolves to a different IP than the server's LAN IP, set `WEBRTC_ADDITIONAL_HOSTS` to the server's LAN IP.
- **RTSP returns 401.** The username must be the *stream name* and the password the *stream password*. URL-encode special characters in the password (the admin page does this for you).
- **RTSP returns 404.** The stream exists but no camera is connected. Check the camera device.
- **The NVR can't decode the stream.** Make sure the camera uses the H.264 codec (the default). Some older NVRs don't support Opus audio; turn off audio on the camera page.
- **To reset everything:** stop the stack and delete `./data/db.json`. The next visit opens the admin setup page again.

## Development

```bash
docker compose up -d --build
# end-to-end test (needs node, ffprobe and playwright):
cd test && npm install --no-save playwright && npx playwright install chromium && ./e2e.sh
```

CI runs the end-to-end test on every push. The test logs in with a headless Chromium using a fake camera and checks the RTSP output with ffprobe. If it passes, CI publishes multi-arch images (`amd64`, `arm64`, `arm/v7`) to `ghcr.io/revocx35/web-ip-cam`.

## License

MIT
