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
| `WEBRTC_ADDITIONAL_HOSTS` | *(empty)* | Comma-separated extra IPs or hostnames to advertise as WebRTC candidates, for example your LAN IP when you open the site through a domain that resolves to a different address. |
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

### Behind a reverse proxy (Caddy, Traefik, Nginx Proxy Manager…)

Point the proxy at `http://<server>:8080` and set `TRUST_PROXY: "true"` (and optionally `HTTPS_ENABLED: "false"`).

The WebRTC media doesn't go through the proxy. Browsers send it directly to port **8189 UDP/TCP**, so the cameras must be able to reach that port. If your domain resolves to an address the cameras can't reach on port 8189, add a reachable address with `WEBRTC_ADDITIONAL_HOSTS`.

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
