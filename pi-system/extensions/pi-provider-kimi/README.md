# pi-provider-kimi

Local fork of `kimicodeprovider` renamed to `pi-provider-kimi` so that npm updates of the upstream package will never overwrite local modifications.

## Origin

- Upstream: `npm:kimicodeprovider`
- Previously installed globally at: `/data/data/com.termux/files/usr/lib/node_modules/kimicodeprovider`

## How to populate this folder

On the Termux device, one-time:

```bash
# 1. Copy the upstream sources into this folder
cp -r /data/data/com.termux/files/usr/lib/node_modules/kimicodeprovider/* ~/pi-system/extensions/pi-provider-kimi/

# 2. Rewrite the package name so pi treats it as a distinct package
node -e "const f='~/pi-system/extensions/pi-provider-kimi/package.json'.replace('~',process.env.HOME); const p=require(f); p.name='pi-provider-kimi'; p.version=p.version+'-fork'; require('fs').writeFileSync(f, JSON.stringify(p,null,2));"

# 3. Install deps
cd ~/pi-system/extensions/pi-provider-kimi && npm install --omit=dev
```

## Local changes

Document every divergence from upstream in `CHANGES.md` with date + reason, so a future rebase on upstream is safe.

## Listed in settings.json as

```json
"~/pi-system/extensions/pi-provider-kimi"
```
