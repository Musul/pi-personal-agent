# pi-cron-forked

Local fork of `@e9n/pi-cron` renamed to `pi-cron-forked` so that npm updates never overwrite local modifications.

## Origin

- Upstream: `npm:@e9n/pi-cron`
- Previously installed globally

## How to populate this folder

On the Termux device, one-time:

```bash
# 1. Copy the upstream sources
cp -r /data/data/com.termux/files/usr/lib/node_modules/@e9n/pi-cron/* ~/pi-system/extensions/pi-cron-forked/

# 2. Rewrite the package name
node -e "const f='~/pi-system/extensions/pi-cron-forked/package.json'.replace('~',process.env.HOME); const p=require(f); p.name='pi-cron-forked'; p.version=p.version+'-fork'; require('fs').writeFileSync(f, JSON.stringify(p,null,2));"

# 3. Install deps
cd ~/pi-system/extensions/pi-cron-forked && npm install --omit=dev
```

## Local changes

See `CHANGES.md`.

## Listed in settings.json as

```json
"~/pi-system/extensions/pi-cron-forked"
```
