# pi-tool-costos

Registro de gasto de IA para el agente. Lee el `usage`/`cost` que pi-mono ya
guarda en cada sesión y lo agrega en un ledger local, sin depender de APIs
externas ni de la memoria del modelo.

## Qué resuelve

Pi guarda por cada mensaje del asistente (y por tools/resúmenes que hacen
llamadas LLM) los tokens y el costo estimado en:

```
~/.pi/agent/sessions/<proyecto>/<timestamp>_<uuid>.jsonl
```

Ese dato se ve en el footer y en `/session`, pero es **por sesión**. Esta
extensión lo consolida entre sesiones y cron jobs, y expone reportes por día,
semana, mes o histórico.

## Uso

```bash
node ~/pi-system/extensions/pi-tool-costos/costos.js            # hoy
node ~/pi-system/extensions/pi-tool-costos/costos.js semana
node ~/pi-system/extensions/pi-tool-costos/costos.js mes
node ~/pi-system/extensions/pi-tool-costos/costos.js mes-anterior
node ~/pi-system/extensions/pi-tool-costos/costos.js todo
node ~/pi-system/extensions/pi-tool-costos/costos.js detalle --dias 30
node ~/pi-system/extensions/pi-tool-costos/costos.js 2026-11-05
node ~/pi-system/extensions/pi-tool-costos/costos.js --desde 2026-11-01 --hasta 2026-11-15
node ~/pi-system/extensions/pi-tool-costos/costos.js todo --telegram
node ~/pi-system/extensions/pi-tool-costos/costos.js todo --json
```

Dentro de pi:

```text
/costos
/costos mes
/costos detalle --dias 30
/costos todo --telegram
```

Acciones de mantenimiento:

```bash
# Escanear sesiones y agregar eventos nuevos al ledger
node ~/pi-system/extensions/pi-tool-costos/costos.js sync

# Reconstruir el ledger desde cero (renombra el anterior a .bak-<timestamp>)
node ~/pi-system/extensions/pi-tool-costos/costos.js rebuild
```

## Datos

- `~/workspace/costos/ledger.jsonl` — ledger append-only, una línea por
  llamada facturable.
- `~/workspace/costos/state.json` — caché de tamaño/mtime por archivo de
  sesión. Solo acelera el escaneo; si se borra, se reconstruye solo.
- Cada evento guarda fecha local, provider/modelo, tokens, costo y sesión.
- La clave de deduplicación usa `entry.id` + timestamp + usage. `/fork` y
  `/clone` copian los entry ids, así que el historial copiado no se cuenta dos
  veces. Las ramas nuevas (respuestas realmente generadas) sí se cuentan.
- El directorio está en `.gitignore`; no se versiona el gasto personal.

## Cómo se calcula

- Incluye mensajes `assistant`, `toolResult` con `usage` anidado, y
  `compaction`/`branch_summary` con usage propio (resúmenes).
- El costo sale del `usage.cost` que calcula pi con el catálogo de precios del
  modelo. Si el modelo no tiene pricing, los tokens se cuentan y el costo queda
  en `$0` (el reporte lo avisa).
- Los providers de suscripción (`kimi-coding`, `opencode-go`, `openai-codex`,
  `github-copilot`) se marcan como costo nominal, no gasto real de bolsillo.
- La fecha se asigna en la zona horaria local (`COSTOS_TZ`, `PI_TZ` o la del
  sistema).

## Telegram

`--telegram` envía el reporte con `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.
Si faltan, cae a `~/.pi/agent/telebridge.json` (la config del canal de
Telegram). No imprime ni persiste el token.

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `COSTOS_DATA_DIR` | `~/workspace/costos` | Directorio del ledger |
| `COSTOS_SESSIONS_DIR` | `PI_CODING_AGENT_SESSION_DIR` o `~/.pi/agent/sessions` | Raíz de sesiones a escanear |
| `COSTOS_TZ` | `PI_TZ` o zona del sistema | Zona horaria de los cortes diarios |
| `PI_CODING_AGENT_SESSION_DIR` | — | Fallback de pi si no hay `COSTOS_SESSIONS_DIR` |
| `PI_LOCALE` | `es-VE` | Idioma de meses y fechas |
| `TELEGRAM_BOT_TOKEN` | — | Envío opcional a Telegram |
| `TELEGRAM_CHAT_ID` | — | Envío opcional a Telegram |

## Limitaciones

- Es una estimación basada en el catálogo de precios de pi, no una factura.
- Si se borran sesiones viejas, `rebuild` pierde esos eventos; el ledger
  existente los conserva.
- Las sesiones efímeras (`--no-session`) no dejan JSONL y no se pueden
  contabilizar.
- No registra tráfico que no pase por pi (por ejemplo, otras herramientas del
  usuario).
- El gasto de IA es un sistema separado de `~/workspace/finanzas/`; no se
  mezcla con gastos personales.
