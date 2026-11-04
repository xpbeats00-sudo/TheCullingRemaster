# Update infrastructure

How releases of The Culling Remaster are built, signed, hosted and published. Written 2026-11-04.

## Hosting today

| What | Where | Served as |
|---|---|---|
| Release objects | VPS `C:\culling\updates\objects\<sha256>` | `https://xplab.shop:8443/remaster/objects/<sha256>` |
| Manifest + signature | VPS `C:\culling\updates\manifest.json(.sig)` | `https://xplab.shop:8443/remaster/manifest.json` (`Cache-Control: no-cache`) |
| Launcher setup | VPS `C:\ssr\www\download\TheCullingRemasterSetup.exe` | `https://xplab.shop/download/TheCullingRemasterSetup.exe` |
| Account server | VPS service `culling-server` on 127.0.0.1:8100 | `https://xplab.shop:8443/api`, `/health` |

**Caddy** (the Superstar Racing VPS's HTTPS server, site file `C:\ssr\caddy\sites\culling.caddy`, written by `deploy/install_vps.ps1`) serves the files. I checked its behaviour live on 2026-11-04:
- stable ETags;
- `Accept-Ranges: bytes`;
- `206` with a correct `Content-Range`;
- `If-Range` honoured, so a stale tag gets a full `200`;
- `416` with `Content-Range: bytes */<size>`.

**The VPS:** Windows Server, Hostinger, US, IP 217.60.97.88.

**Release 1.1.0** is published there in the old `files/<path>` layout. Launchers follow each entry's `url`, so both layouts work.

## Object naming and caching

From this version, `tools/make_manifest.js` publishes each file once, as `objects/<sha256>`. The benefits:
- **Immutable:** an object never changes once published. A launcher in the middle of a download can't have the file swapped under it, and objects can be cached forever.
- **Deduplicated:** identical files are stored once.
- **Differential:** a new release only adds the objects that changed.

**Cache policy (to apply):** `objects/*` → `Cache-Control: public, max-age=31536000, immutable`; `manifest.json(.sig)` → `no-cache`. Live today: `no-cache` on `manifest.json` only. Both rules (objects immutable; `manifest.json` and its `.sig` no-cache) are in `deploy/install_vps.ps1` on the `server-hardening` branch and apply the next time `Update Culling Server.bat` runs after it's merged. *(Not verified on the VPS; the installer runs `caddy validate` before reloading.)*

## Signing

- **Key pair:** made once with `node launcher/tools/make_release_key.js`. The private key is Ed25519 at `%USERPROFILE%\.culling-release\release_ed25519.pem` on the build PC. It is never committed or uploaded.
- **Public key:** `launcher/lib/releasekey.js`, built into every launcher.
- **Signing:** `make_manifest.js` signs every manifest (`manifest.json.sig`).
- **Checking:**
  - `deploy/verify_release.js` checks the signature before anything is published;
  - every launcher checks it before trusting a manifest.
- **Key loss or rotation:** a new key needs a new launcher build carrying the new public key. Old launchers then refuse new releases until players update the launcher, so **back the private key up offline**.
- **Better later:** keep the key on a hardware token or in a signing service, and add a second key so the next launcher can trust two.

## Building a release

On the build PC:

```
python patch/make_release.py https://xplab.shop:8443 <version> --full ../TheCulling
```

1. Points the menus and HUD at the server, packs the Remaster patch, then restores the local setting.
2. With `--full`, hard-links the whole game install in, leaving out this PC's Steam identity and name, the client DLLs the launcher makes, the replaced patch and Steam's install script.
3. `make_manifest.js` hashes, deduplicates into `objects/` and signs, writing to `releases/<version>/publish/`.

## Publishing (needs the VPS)

On the VPS, over Remote Desktop with the build PC's C: drive shared, run `Publish Release.bat <version>`. That runs `deploy/publish_release.ps1`:

1. **Signature check** with the launcher's key. An unsigned or altered release is refused.
2. **`deploy/stage_objects.js`**, for each object:
   - already present: reused;
   - in the old `files/` layout with the right hash: hard-linked, so republishing 1.1.0 as objects uploads nothing;
   - otherwise: copied from the build PC and checked against its SHA-256.

   Objects are never overwritten. (Tested by `deploy/stage_objects.test.js`.)
3. **Swap-in:** the signature, then the manifest, each swapped in whole. A launcher that reads between the two retries once.
4. **The setup** is copied to the website's download folder, which the website deploy keeps.
5. **Checks:** the public manifest version and the setup's size.

## Rolling back a release

- **Server side:** republish the previous release's folder (`releases/<old>/publish`); its objects are still on the VPS. Installed launchers then see an older version and **refuse it**: downgrades are blocked by design. To really roll players back, publish the old content under a new, higher version number (for example 1.1.2 with 1.1.0's files). Only changed objects download.
- **Player side:** Settings → Restore previous version brings back the files kept from before the last update.

## Retention

- Objects are kept as long as any published manifest might need them. Nothing deletes them yet.
- The old `files/` tree can be removed once no published manifest references it, after 1.1.0 is republished as objects.

## CDN

There is no CDN now. The VPS served full line speed to the one client I could test (8+ MB/s). How it holds up with many players downloading at once, or from other continents, isn't measured.

**When to add one:** if several players install at once, or players outside North America report slow downloads.

**Options** (each needs an account and payment decision, so none is set up):
- **Cloudflare R2** (no egress fees) behind a custom domain;
- **Bunny CDN** (pay per GB, simple pull zone pointing at `https://xplab.shop:8443/remaster/`).

Both work with the launcher as it is. Point the manifest's `url` entries, or the launcher's `manifestUrl`, at the CDN. Payloads are immutable objects, so a pull-through CDN caches them for good. Keep the manifest on the origin, or set it to no-cache.

**Requirements:** HTTPS, Range/206, stable ETags, no redirects (the launcher refuses them), and no credentials in the launcher.

## Access controls

- **VPS:** administration over Remote Desktop.
- **SSH:** this PC's key (`tso_vps`) is refused for Administrator; authorizing a key is your decision.
- **Account server:** listens on 127.0.0.1 only, reached through Caddy.
- **Metrics:** the endpoint answers loopback only and refuses forwarded requests (see SERVER_PERFORMANCE_AUDIT).
- **Release signing key:** on the build PC only.
