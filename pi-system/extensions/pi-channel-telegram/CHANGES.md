# Cambios del Fork (`pi-channel-telegram`)

Fork local de [`pi-telebridge`](https://github.com/acarerdinc/pi-telebridge). Renombrado a `pi-channel-telegram` para alinear con el contrato de canales de pi-system.

## 2026-04-25 — v2.0.1 — Fix race condition en transición de turnos

**Bug:** un mensaje de Telegram que llegaba justo mientras el agente estaba terminando la respuesta final del turno previo (entre `turn_end` del turno A y `message_start` del turno B) hacía que la respuesta del turno B nunca se enviara a Telegram.

**Causa:** el handler `pi.on("input")` drenaba el `telegramQueue` con `shift()` aún cuando había un `activeTurnChatId` ya bindeado. El `chatId` del mensaje 2 se descartaba silenciosamente. Después, cuando el turno A limpiaba `activeTurnChatId = null` y arrancaba el turno B, ya no quedaba nada en la cola para bindear y `turn_end` retornaba sin enviar.

**Fix:**
- `input` handler: solo consume del queue si `activeTurnChatId === null`. Si hay turno activo, deja el mensaje en la cola.
- `message_start` handler: misma regla — no drena si ya está bindeado.
- `turn_end` handler: cuando libera `activeTurnChatId` y el queue tiene pendientes, rebindea inmediatamente al próximo `chatId` para que el turno B (que pi-mono está por iniciar por el steer/followUp) tenga su destino.

Ningún chatId puede perderse en transición.

## ¿Por qué existe este fork?

- **Integración con `pi-cron`:** Se añadió soporte para reenviar los resultados de los jobs de cron a Telegram mediante el evento `cron:job_complete`.
- **Mantenimiento local:** Permite modificar el comportamiento del bridge sin depender de actualizaciones del paquete npm original.

## Diferencias respecto al original

### 1. Integración con cron (`src/index.ts`)
Escucha el evento `cron:job_complete` del bus de extensiones (`pi.events`) y envía un resumen del resultado del job a Telegram:

```typescript
pi.events.on("cron:job_complete", async (event: any) => {
  // Envía ✅/❌ + nombre del job + duración + error/respuesta a Telegram
});
```

### 2. Corrección del ciclo de vida de sesiones (`src/index.ts`)
**Problema:** El fork original incluía un handler para `session_switch`, un evento que **no existe** en `pi-coding-agent`. Esto causaba que el cleanup nunca se ejecutara correctamente al cambiar de sesión.

**Solución aplicada (16 abr 2026):**
- Se eliminó el handler `pi.on("session_switch", ...)`.
- Se consolidó todo el cleanup (parar bot, limpiar estado de UI, resetear flags) dentro del handler existente `session_shutdown`.

Ahora el flujo de cambio de sesión se ve así:

| Evento | ¿Qué hace el fork? |
|--------|-------------------|
| `session_before_switch` | Envía mensaje de desconexión a Telegram y para el bot. |
| `session_shutdown` | Limpieza definitiva: para el bot, resetea `relayEnabled`, limpia el status de la UI. |
| `session_start` | Resetea todo a cero en la nueva sesión. |

### 3. Arquitectura asincrónica por turnos (`src/index.ts`) — Abr 2026
**Problema:** El diseño original usaba una flag booleana global `lastMessageFromTelegram` que se reseteaba por cualquier evento `input` espurio. Cuando el agente tardaba mucho o había steering encadenado, la respuesta se perdía silenciosamente.

**Solución aplicada:**
- Se eliminó la flag global frágil.
- Se implementó un sistema de tracking por turno usando una cola FIFO (`telegramQueue`) + `activeTurnChatId`.
- Las respuestas se envían en `turn_end` (una por turno) en lugar de esperar a `agent_end`.
- `agent_end` se mantiene solo como fallback para errores/abort.
- Vinculación dual:
  - `input` (source === "extension") para mensajes enviados cuando el agente está idle.
  - `message_start` con matching de texto para mensajes encolados (steering/followUp).

### 4. Notificaciones de tool calls (`src/index.ts`) — Abr 2026
**Feature toggleable** vía `/telegram tools`.
- Escucha `tool_execution_start` y envía un resumen corto del comando a Telegram.
- Solo notifica cuando el turno actual viene de Telegram.
- Persiste en `telebridge.json` (`notifyTools`).

Resumen por tool:
| Tool | Ejemplo en Telegram |
|------|---------------------|
| `bash` | 🔧 `bash: ls -la` |
| `read` | 🔧 `read: src/index.ts` |
| `edit` | 🔧 `edit: src/index.ts` |
| `write` | 🔧 `write: src/config.ts` |
| `grep` | 🔧 `grep: "pattern" src/` |
| `find` | 🔧 `find: src/` |
| `ls` | 🔧 `ls: src/` |

### 5. Soporte para documentos (`src/bot.ts` + `src/index.ts`) — Abr 2026
- Handler `message:document` en el bot de Grammy.
- Descarga archivos a `~/.pi/agent/documents/`.
- Reenvía al agente como `[Document received: <path>] <caption>`.
- Límite de Telegram: 20MB por archivo.

### 6. Retry en envíos (`src/bot.ts`) — Abr 2026
- `sendTextWithRetry` con 3 intentos y backoff exponencial.
- Reemplaza a `sendText` en todos los puntos críticos para no perder respuestas por timeouts de red puntual.

## Configuración requerida en `pi`

En `~/.pi/agent/settings.json`, la entrada debe ser la **ruta absoluta sin prefijo `path:`**:

```json
{
  "packages": [
    "/data/data/com.termux/files/home/workspace/pi-telebridge-fork"
  ]
}
```

> ⚠️ **Nota importante:** No usar `"path:/ruta/..."`. `pi` no interpreta `path:` como un protocolo; lo concatena literalmente al path base y la extensión nunca carga.

## Cómo usar

Dentro del TUI de `pi`:

- `/telegram` — Activa/desactiva el relay con Telegram.
- `/telegram setup` — Configura el bot token y descubre el `chatId`.
- `/telegram status` — Muestra el estado actual del bot, chat y relay.
