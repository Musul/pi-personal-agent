# Propuesta — Ingesta automática de transacciones bancarias (SMS + email)

**Estado:** propuesta de diseño. No hay código implementado.
**Objetivo:** que el agente detecte consumos, pagos, transferencias y abonos que llegan por SMS y correo, los registre solo en `~/workspace/finanzas/`, evite duplicados y mantenga un rastro auditable.
**Restricción:** todo corre en el Android del usuario, dentro de Termux. Sin servidor, sin base de datos, sin app propia.

---

## 0. Resumen ejecutivo

| Decisión | Propuesta |
|---|---|
| Dónde vive | Se suma a `pi-tool-finanzas`, que ya es dueño del libro mayor |
| Fuentes | SMS vía Termux:API, email vía IMAP, y pegado/forward manual para entrenar |
| Procesamiento | Reglas determinísticas por banco; **sin LLM en el camino crítico** |
| Duplicados | Hash exacto + ID externo + huella semántica + ventana temporal |
| Registro | Automático solo con confianza alta; el resto va a una bandeja de revisión |
| Contabilidad | Separa gasto/ingreso de transferencias internas, pago de tarjeta, retiro y operaciones declinadas |
| Avisos | Silencio por defecto + digest diario; alerta inmediata solo para fraude/declinadas/montos altos |
| Batería | Cero daemon; JobScheduler cada 15–30 min o evento de SMS con MacroDroid |
| Privacidad | Texto bancario se queda en el teléfono; OTP nunca se guarda; credenciales en `~/.env` |
| Esfuerzo MVP | 3–4 sesiones, empezando con muestras reales y modo dry-run |

**Lo que no incluye, a propósito:** WhatsApp, notificaciones push de apps bancarias, scraping de home banking, lectura de estados de cuenta PDF, sincronización multi-dispositivo ni UI web.

### Funciones concretas

1. **Detectar** mensajes bancarios entre todos los SMS/correos, por remitente y formato.
2. **Extraer** monto, moneda, fecha, comercio, cuenta/tarjeta, referencia y saldo cuando exista.
3. **Clasificar** cada movimiento: gasto, ingreso, transferencia interna, pago de tarjeta, retiro, reembolso o declinada.
4. **Deduplicar** el mismo consumo cuando llega por SMS y por email, o cuando se reprocesa.
5. **Categorizar** con reglas por comercio y aprender de las correcciones del usuario.
6. **Registrar** automáticamente solo lo confiable; lo dudoso va a una bandeja de revisión.
7. **Avisar** con un digest diario y alertas puntuales de fraude, declinadas o montos altos.
8. **Corregir y deshacer** cualquier movimiento sin borrar el historial.
9. **Auditar y reprocesar** mensajes cuando un banco cambia el formato.
10. **Diagnosticar** permisos, credenciales y perfiles con un solo comando.

---

## 1. Punto de partida

Lo que ya existe y sirve:

- `finanzas.js` con `add`, `balance`, `search`, `report`, presupuestos y FX opcional.
- `transacciones.csv` como libro mayor, `prestamos.csv`, `presupuestos.json`.
- Reportes mensuales y alertas de presupuesto al 80/100 %.
- Agente con Telegram, cron, `TAREAS.md`, backups y `parse_document`.
- Datos de finanzas ya excluidos del repo por `.gitignore`.

Lo que hoy impide la ingesta automática:

| Gap | Consecuencia |
|---|---|
| No hay ID de transacción | No se puede enlazar un SMS con su email, ni deshacer sin contar filas |
| No hay campo `origen` ni `ref_externa` | No se sabe si un gasto vino de SMS, email o carga manual |
| No hay dedupe | El mismo consumo por SMS y email se registraría dos veces |
| `parseMonto` reemplaza `,` por `.` | `1.234,56` se vuelve inválido; formato venezolano roto |
| Solo existen `tipo: gasto|ingreso` | Una transferencia entre cuentas propias infla gastos e ingresos |
| `add` usa la tasa del día | Un consumo de ayer se convierte con la tasa de hoy |
| No hay bandeja de revisión | Un parser dudoso no tiene dónde esperar confirmación |
| No hay lector de email ni de SMS | Es la funcionalidad nueva en sí |
| No hay Termux:API instalado | SMS requiere app + permiso de lectura |

La conclusión es directa: **no alcanza con un script que lea SMS y llame a `finanzas.js add`**. Hace falta una capa de ingesta con inbox, perfiles, dedupe y auditoría. El libro mayor puede seguir siendo el mismo CSV.

---

## 2. Principios de diseño

1. **Un solo dueño del dato.** La ingesta escribe por `finanzas.js`; no crea un segundo libro mayor paralelo.
2. **Inbox primero, parseo después.** Cada mensaje crudo se guarda una vez con un hash. Si el parser mejora, se puede reprocesar sin volver a leer el banco.
3. **Determinístico antes que generativo.** Los formatos bancarios son repetitivos; una regex probada es más barata, rápida y privada que un LLM.
4. **Idempotencia.** Reprocesar el mismo SMS o volver a bajar el mismo email no debe crear otra transacción.
5. **Contabilidad conservadora.** Ante duda, no se registra como gasto: va a revisión.
6. **Automático pero reversible.** Toda transacción automática tiene ID, origen y `undo`.
7. **Privacidad por defecto.** El texto bancario no sale del teléfono; los OTP se descartan antes de guardar.
8. **Cero daemon.** Nada de watchers ni conexiones IMAP permanentes. Se ejecuta por job o a pedido.

---

## 3. Arquitectura

```text
 SMS (Termux:API) ─┐
 Email (IMAP) ─────┼──► ingestas.jsonl ──► perfiles por banco ──► extracción
 Pegado/forward ───┘         │                                      │
                             │                                      ▼
                             │                              clasificación
                             │                                      │
                             │                                      ▼
                             │                                 dedupe
                             │                                      │
                             │                    ┌─────────────────┴─────────────────┐
                             │                    ▼                                   ▼
                             │            confianza alta                    confianza media/baja
                             │                    │                                   │
                             │                    ▼                                   ▼
                             │          transacciones.csv v2                 bandeja de revisión
                             │                    │                          (Telegram / agente)
                             └────────────────────┴──────────────► auditoría y undo
```

### 3.1 Por qué dentro de `pi-tool-finanzas`

La regla del repo dice que dos extensiones con acoplamiento fuerte deben fusionarse. La ingesta necesita el mismo esquema, las mismas tasas, las mismas categorías y el mismo reporte. Crear `pi-tool-ingesta` separado obligaría a duplicar configuración o a llamar `finanzas.js` por `child_process` en cada movimiento.

Si más adelante aparece la necesidad de leer correo en general (no solo finanzas), se puede extraer un `pi-tool-correo` y dejar la ingesta como consumidor. Hoy sería scope creep.

### 3.2 Modos de ejecución

| Modo | Cómo | Cuándo |
|---|---|---|
| A pedido | `finanzas.js ingest sms` / `ingest email` dentro de una sesión | MVP y pruebas |
| Programado | `termux-job-scheduler` cada 15–30 min ejecuta `ingest.js run --quiet` | Producción sin depender de que `pi` esté abierto |
| Evento SMS | MacroDroid/Tasker dispara `ingest.js sms --once` al recibir SMS | Tiempo real, cero polling |
| Pegado | `ingest text "..."` o reenviar el mensaje al bot | Entrenamiento y casos raros |

---

## 4. Modelo de datos

Todo sigue en `~/workspace/finanzas/`. Nada de datos personales en `pi-system/`.

### 4.1 `transacciones.csv` v2

Columnas actuales:

```text
fecha,descripcion,monto_usd,monto_bs,moneda_origen,tasa,categoria,tipo,notas
```

Columnas nuevas, **al final** para no romper escrituras viejas:

```text
...,notas,id,estado,naturaleza,cuenta,origen,ref_externa,confianza
```

| Campo | Ejemplo | Uso |
|---|---|---|
| `id` | `tx-20261110-0007` | Enlace con ingesta, undo, correcciones |
| `estado` | `activa` / `anulada` | Undo sin borrar filas |
| `naturaleza` | `gasto`, `ingreso`, `transferencia_interna`, `pago_tarjeta`, `retiro_efectivo`, `reembolso` | Semántica contable fina |
| `cuenta` | `bdv-debito-1234` | Tarjeta/cuenta de origen |
| `origen` | `manual`, `sms`, `email`, `sms+email` | Procedencia |
| `ref_externa` | `123456` | Referencia del banco |
| `confianza` | `0.98` | Calidad del parseo |

Compatibilidad: como las columnas nuevas van al final, una escritura vieja de 9 columnas sigue siendo válida; las nuevas quedan vacías. `readCsv` ya mapea por encabezado. La migración solo reescribe el encabezado y rellena valores por defecto (`estado=activa`, `origen=manual`, `confianza=1.0`) con backup previo.

**Regla de lectura:** todos los comandos de consulta (`balance`, `report`, `search`, `tx list`) deben tratar `estado` vacío como `activa` y excluir `anulada`. Así el undo no borra nada y los reportes históricos siguen siendo correctos.

**Importante:** `tipo` se mantiene para no romper `balance` y `report`. Para movimientos que no son P&L se usa `tipo=neutro`; `balance` ya ignora todo lo que no sea `ingreso` o `gasto`.

### 4.2 `ingestas.jsonl` (append-only)

Una línea por mensaje crudo. Soporta 1:N: un email de resumen puede producir varios movimientos.

```json
{
  "id": "ing-000123",
  "hash": "sha256:9f2c...",
  "fuente": "sms",
  "emisor": "2665",
  "recibido": "2026-11-10T14:32:00-04:00",
  "texto": "BDV: Consumo TDD ****1234 por Bs. 1.234,56 en FARMATODO...",
  "perfil": "bdv-sms-v1",
  "movimientos": [
    {
      "monto": 1234.56,
      "moneda": "VES",
      "naturaleza": "gasto",
      "comercio": "FARMATODO",
      "cuenta": "bdv-debito-1234",
      "fecha": "2026-11-10",
      "ref": "123456"
    }
  ],
  "confianza": 0.98,
  "estado": "registrada",
  "tx_ids": ["tx-20261110-0007"],
  "motivo": null
}
```

Estados: `nueva`, `parseada`, `registrada`, `duplicada`, `revisar`, `ignorada`, `error`.

Reglas:

- `hash` = SHA-256 de `fuente + emisor + texto normalizado + fecha externa`. Evita reprocesar.
- `texto` se guarda **redactado**: sin OTP, sin número completo de tarjeta, sin CVV. Retención configurable (default 90 días); el registro parseado queda para siempre.
- `motivo` explica por qué no se auto-registró (`perfil_desconocido`, `monto_ambiguo`, `cuenta_desconocida`, `posible_duplicado`, `monto_alto`).
- `replay` vuelve a parsear un `ing-*` después de corregir un perfil.

### 4.3 `cuentas.json`

```json
{
  "schema": 1,
  "cuentas": [
    {
      "id": "bdv-debito-1234",
      "banco": "BDV",
      "tipo": "debito",
      "moneda": "USD",
      "ultimos4": "1234",
      "alias": "Cuenta principal",
      "propia": true
    },
    {
      "id": "mercantil-credito-5678",
      "banco": "Mercantil",
      "tipo": "credito",
      "moneda": "USD",
      "ultimos4": "5678",
      "alias": "Tarjeta consumo",
      "propia": true
    },
    {
      "id": "efectivo-usd",
      "banco": null,
      "tipo": "efectivo",
      "moneda": "USD",
      "propia": true
    }
  ]
}
```

Sirve para tres cosas críticas:

1. Resolver `****1234` a una cuenta real.
2. Detectar transferencias entre cuentas propias.
3. Detectar pago de tarjeta (débito → crédito propio), que **no** es un gasto nuevo.

Sin `cuentas.json`, la ingesta no puede distinguir una compra de un pago de tarjeta. Ante cuenta desconocida, va a revisión.

### 4.4 `perfiles.json` (adaptadores por banco)

```json
{
  "schema": 1,
  "perfiles": [
    {
      "id": "banco-ejemplo-sms-v1",
      "fuente": "sms",
      "emisor": ["2665"],
      "match": "^(BANCO EJEMPLO|BE):",
      "moneda_default": "VES",
      "campos": {
        "monto": "Bs\\.?\\s*([\\d.,]+)",
        "tarjeta": "(?:TDD|TDC|TARJETA)\\s*\\*+\\s*(\\d{4})",
        "comercio": "(?:EN|COMERCIO)\\s+([A-Z0-9 .&'-]+?)(?:\\s+\\d{2}/|$)",
        "ref": "(?:REF|APROB)\\s*:?\\s*(\\d+)",
        "fecha": "(\\d{2}/\\d{2}/\\d{2,4})"
      },
      "reglas": {
        "consumo": "gasto",
        "abono": "ingreso",
        "transferencia recibida": "ingreso",
        "pago movil recibido": "ingreso",
        "retiro": "retiro_efectivo",
        "reverso": "reembolso",
        "rechazada": "declinada"
      },
      "tests": ["fixtures/sms/banco-ejemplo-01.txt"]
    }
  ]
}
```

Reglas:

- Un perfil se identifica por `fuente + emisor + match`. Nunca solo por emisor: el mismo short code puede mandar publicidad.
- Cada campo puede ser un string regex o un array de regex; se prueba en orden.
- `moneda_default` evita adivinar cuando el SMS dice solo `Bs.`.
- Los perfiles reales se construyen con mensajes reales del usuario, no con formatos inventados.
- Versionado: si el banco cambia el formato, se crea `-v2` y se conserva `-v1` para `replay`.

### 4.5 `comercios.json` (categorización)

```json
{
  "schema": 1,
  "reglas": [
    { "match": "FARMATODO|FARMACIA|LOCATEL", "categoria": "salud", "prioridad": 10 },
    { "match": "UBER|YEGO|DIDI|TAXI", "categoria": "transporte", "prioridad": 10 },
    { "match": "NETFLIX|SPOTIFY|DISNEY|MAX", "categoria": "suscripciones", "prioridad": 10 },
    { "match": "SUPERMERCADO|EXCELSIOR|PLAZA|CENTRAL", "categoria": "supermercado", "prioridad": 5 }
  ],
  "aprendidas": [
    { "comercio": "TIENDA XYZ", "categoria": "hogar", "veces": 3 }
  ]
}
```

- `prioridad` resuelve solapamientos.
- `aprendidas` se llena cuando el usuario corrige una categoría (`tx cat`).
- Comercio desconocido → `sin-categoria`, no `gastos-hormiga`. Así el digest puede pedirte que lo clasifiques en vez de esconderlo.

### 4.6 `config.json` y secretos

`~/workspace/finanzas/config.json` (no secreto):

```json
{
  "schema": 1,
  "ingesta": {
    "modo": "confirm",
    "auto_max_usd": 300,
    "confianza_min": 0.9,
    "dedupe_ventana_dias": 3,
    "retencion_texto_dias": 90,
    "sms": {
      "enabled": true,
      "remitentes": ["2665", "2777"],
      "limite": 50
    },
    "email": {
      "enabled": true,
      "host": "imap.gmail.com",
      "puerto": 993,
      "carpeta": "INBOX",
      "remitentes": ["alertas@banco.com"],
      "desde_dias": 7
    }
  }
}
```

Secretos en `~/.env`:

```bash
FIN_IMAP_USER="..."
FIN_IMAP_PASS="..."
```

Nunca en el repo, nunca en logs, nunca en el prompt.

### 4.7 Migración

`finanzas.js migrate`:

1. Backup `transacciones.csv.bak-YYYYMMDD-HHMMSS`.
2. Agrega columnas al final si faltan.
3. Genera `id` para filas que no tengan uno.
4. Rellena `estado=activa`, `origen=manual`, `confianza=1.0`; infiere `naturaleza` desde `tipo` (`gasto`/`ingreso`); deja `cuenta` y `ref_externa` vacías.
5. No toca montos, fechas ni categorías.
6. Es idempotente.

Rollback: restaurar el backup. Los datos de ingesta quedan en `ingestas.jsonl` y se pueden borrar aparte.

---

## 5. Pipeline

### 5.1 Colecta

Cada fuente devuelve un sobre mínimo:

```json
{ "fuente": "sms", "emisor": "2665", "fecha": "2026-11-10T14:32:00-04:00", "texto": "...", "id_externo": "12345" }
```

- **SMS:** `termux-sms-list`.
- **Email:** IMAP, solo remitentes configurados, sin marcar como leído.
- **Pegado:** texto plano + emisor declarado.

### 5.2 Normalización

- Decodificar HTML a texto si es email.
- Colapsar espacios y saltos.
- Pasar a mayúsculas solo para matching; conservar el original para el comercio.
- Quitar firmas, avisos legales y respuestas citadas.
- **Filtrar OTP antes de guardar:** si contiene `código de verificación`, `OTP`, `token`, `clave dinámica`, `no comparta`, se descarta el cuerpo y solo se registra `{fuente, emisor, fecha, motivo:"otp"}`.
- **No seguir links.** Si el mensaje pide "verificar operación" con URL, se marca sospechoso y no se registra.

### 5.3 Match de perfil

- Coincidencia exacta de emisor + `match`.
- Si no hay perfil → `revisar` con `perfil_desconocido`. No se adivina con LLM por defecto.
- Si hay más de un perfil → se prueba el más específico y se registra cuál ganó.

### 5.4 Extracción

Campos: monto, moneda, naturaleza, comercio, cuenta/últimos4, fecha, referencia, saldo (opcional).

**Parser de montos locale-aware** (el actual no sirve):

| Texto | Resultado | Regla |
|---|---|---|
| `1.234,56` | `1234.56` | VES: punto = miles, coma = decimal |
| `1,234.56` | `1234.56` | USD: coma = miles, punto = decimal |
| `12,34` | `12.34` | dos decimales tras coma |
| `12.34` | `12.34` | dos decimales tras punto |
| `1.234` | ambiguo | VES → `1234`; USD → `1.234`; sin moneda → revisar |
| `1,234` | ambiguo | ídem |
| `Bs. 1.234,56` | `1234.56 VES` | moneda explícita |
| `$ 1,234.56` | `1234.56 USD` | moneda explícita |

La moneda manda: si el mensaje dice `Bs.` o `VES`, se aplica formato venezolano; si dice `USD` o `$`, formato anglosajón. Sin moneda y con separadores ambiguos, no se auto-registra.

**Fechas:** `DD/MM/YYYY` por locale `es-VE`, `YYYY-MM-DD` ISO, y `DD-MM-YY`. Si el cuerpo no trae fecha, se usa la fecha del mensaje con penalización de confianza.

**Cuenta:** últimos 4 dígitos + banco. Si no se resuelve, `cuenta=desconocida` y revisión.

**Referencia:** número de aprobación, referencia o comprobante. Es la mejor llave para dedupe.

### 5.5 Clasificación

Palabras clave → naturaleza:

| Señal | Naturaleza | Efecto |
|---|---|---|
| consumo, compra, pago, débito | `gasto` | resta |
| abono, crédito, recibido, depósito, pago móvil recibido | `ingreso` | suma |
| transferencia entre cuentas propias | `transferencia_interna` | neutro |
| pago tarjeta / pago TDC | `pago_tarjeta` | neutro |
| retiro, cajero, ATM | `retiro_efectivo` | neutro por defecto |
| reverso, devolución, reembolso | `reembolso` | compensa |
| rechazada, declinada, no aprobada | `declinada` | no se registra; alerta |
| saldo disponible / saldo actual | — | no es transacción |

Si hay señales contradictorias (`consumo` + `reverso` en el mismo mensaje), gana la más específica y se baja la confianza.

### 5.6 Dedupe

Cuatro capas, de más barata a más difusa:

1. **Hash exacto** del texto normalizado + emisor + fecha externa. Atrapa reprocesamientos y reenvíos idénticos.
2. **ID externo**: `_id` de SMS, `Message-ID`/`UIDVALIDITY+UID` de email. Atrapa la misma fuente leída dos veces.
3. **Huella con referencia**: `sha256(cuenta|fecha|monto|moneda|naturaleza|ref)`. Si hay `ref`, es casi infalible.
4. **Fuzzy sin referencia**, solo entre canales distintos o mensajes casi idénticos:
   - mismo monto exacto,
   - misma cuenta o mismo comercio con similitud ≥ 0.8,
   - fecha ± 3 días,
   - naturaleza compatible,
   - diferencia de tiempo ≤ 30 min si son SMS y email.

Reglas para no fusionar compras legítimas repetidas:

- Dos Uber del mismo monto el mismo día, con horas distintas: **se conservan ambos**.
- Dos SMS idénticos con el mismo `_id`: duplicado.
- SMS y email del mismo consumo, mismo monto, misma ref, dentro de 30 min: **un solo movimiento**, `origen=sms+email`.
- Si no hay certeza: `posible_duplicado` → revisión, nunca auto-fusión.

### 5.7 Categorización

Orden:

1. Regla de `comercios.json` con mayor prioridad.
2. Historial: categoría más usada para ese comercio normalizado.
3. Si el banco trae una categoría (raro en SMS), se usa como sugerencia.
4. Nada → `sin-categoria` + revisión.

Normalización de comercio: mayúsculas, sin números de sucursal, sin ciudad, sin `C.A.`, sin `S.A.`. Ejemplo: `FARMATODO 0123 CARACAS` → `FARMATODO`.

### 5.8 Escritura

- Alta confianza → append a `transacciones.csv` con ID, origen, cuenta, ref y confianza.
- Media/baja → solo `ingestas.jsonl` con estado `revisar`.
- Declinadas y mensajes de saldo **no** se escriben en el libro: quedan en `ingestas.jsonl` para auditoría y alerta.
- Toda escritura usa el mismo `finanzas.js` (no se edita CSV a mano).
- `notas` incluye `ing:<id>` para trazabilidad.
- Si el movimiento es en Bs, se convierte a USD con la tasa de la **fecha de la transacción**, no la de hoy:
  - tasa del banco si viene en el mensaje,
  - tasa cacheada de esa fecha en `tasas.json`,
  - si no existe, la más cercana hacia atrás (máximo 7 días) y se marca `tasa_estimada` en notas.

### 5.9 Notificación

- Por defecto, silencio.
- Digest diario (21:00) con movimientos nuevos, totales y cola de revisión.
- Alerta inmediata solo para:
  - operación declinada o “no reconocida”,
  - posible fraude/phishing,
  - monto > `auto_max_usd`,
  - fallo repetido de un perfil que antes funcionaba.
- Alertas de presupuesto: solo al cruzar 80 % o 100 %, una vez por categoría y mes.

---

## 6. Semántica contable

Este es el punto donde la mayoría de los auto-registros fallan. La regla general: **no todo movimiento bancario es gasto o ingreso.**

| Naturaleza | `tipo` | ¿Afecta balance? | ¿Afecta presupuesto? | Ejemplo |
|---|---|---|---|---|
| `gasto` | `gasto` | Sí | Sí | Consumo en Farmatodo |
| `ingreso` | `ingreso` | Sí | No | Sueldo, pago móvil recibido |
| `transferencia_interna` | `neutro` | No | No | Mover de BDV a Mercantil |
| `pago_tarjeta` | `neutro` | No | No | Pagar la TDC desde el débito |
| `retiro_efectivo` | `neutro` | No | No | Cajero automático |
| `reembolso` | `ingreso` | Sí, resta a gastos | Sí, resta en su categoría | Devolución de una compra |
| `declinada` | — | No se escribe | No | Pago rechazado (solo auditoría) |

Los reportes calculan por `naturaleza`, no solo por `tipo`: `gastos_netos = gasto − reembolso`, `ingresos = ingreso`. Para filas viejas sin `naturaleza`, se usa `tipo` como fallback.

Matices que hay que decidir con el usuario:

- **Retiro de efectivo:** si después no carga los gastos en efectivo, el retiro es la única señal de ese gasto. Dos opciones: neutro (recomendado si carga efectivo) o gasto (recomendado si no lo hace).
- **Pago de tarjeta:** si el banco manda el detalle de cada consumo de la tarjeta, el pago es neutro. Si solo manda el pago mensual, habría que tratarlo como gasto o pedir el estado de cuenta.
- **Reembolso:** si se puede enlazar a la compra original, resta de esa categoría; si no, va a `otros-ingresos`.
- **Compra en divisa:** si el mensaje trae monto en USD y en Bs, se usa USD para el libro y se guarda Bs como referencia. Si solo trae Bs, se convierte con la tasa de la fecha.
- **Propina/IVA:** el monto del banco ya es final; no se desglosa.

---

## 7. Fuentes

### 7.1 SMS con Termux:API

**Requisitos:** app Termux:API desde F-Droid, `pkg install termux-api`, permiso de SMS concedido a Termux:API. La app debe estar firmada con la misma clave que Termux (por eso F-Droid, no Play Store).

**Lectura:**

```bash
termux-sms-list --message-type=inbox --message-limit=50 \
  --message-selection="address == '2665'"
```

Devuelve JSON con `_id`, `address`, `body`, `date` (epoch ms), `read`, `type`. Se puede filtrar por remitente y por texto con `body LIKE`, lo que reduce mucho el ruido.

**Realidad:** Termux:API **no** expone un receptor de SMS en tiempo real; el patrón documentado es polling. Hay tres formas:

| Forma | Latencia | Batería | Complejidad |
|---|---|---|---|
| JobScheduler cada 15 min | ≤15 min | Baja, pero 96 ejecuciones/día | Baja |
| JobScheduler cada 30–60 min | ≤30–60 min | Muy baja | Baja |
| MacroDroid/Tasker “SMS recibido” → Termux | Segundos | Casi cero en reposo | Media |

**Recomendación:** JobScheduler cada 30 min para el MVP; si el usuario quiere tiempo real, MacroDroid con filtro por remitente. No hace falta leer todos los SMS: se consultan solo los remitentes configurados.

**Limitaciones:**

- El permiso es global (puede leer todos los SMS), aunque el script filtre.
- Algunos OEM matan Termux; hay que excluirlo de optimización de batería.
- SMS multipartes pueden llegar truncados; el parser debe tolerar cuerpo incompleto y mandar a revisión.
- Short codes bancarios pueden cambiar o ser spoofeados; el `match` por cuerpo es obligatorio.

### 7.2 Email con IMAP

**Requisitos:** una cuenta IMAP. Opciones:

| Proveedor | Autenticación | Nota |
|---|---|---|
| Gmail personal | App password con 2FA (disponible; Google empuja OAuth) | Verificar antes de implementar |
| Gmail Workspace | OAuth2 | Más setup, scope `gmail.readonly` |
| Outlook/Hotmail | OAuth2 | Basic auth eliminado; no sirve app password |
| Yahoo/iCloud/custom | App password / password IMAP | Verificar IMAP habilitado |

**Recomendación fuerte:** crear un **correo dedicado solo para alertas bancarias** y reenviar ahí lo que mandan los bancos. Así el agente nunca tiene acceso al correo personal. Si no querés un correo nuevo, la alternativa es Gmail API con OAuth `gmail.readonly`, que es más trabajo pero más acotado que una app password con acceso total.

**Lectura:**

- `imapflow` + `mailparser` (JS puro, sin binarios nativos).
- Buscar por remitente y fecha: `SEARCH SINCE <fecha> FROM <remitente>`.
- Fetch con `BODY.PEEK[]` para **no marcar como leído**.
- Guardar `UIDVALIDITY` + `UID` por carpeta; si cambia `UIDVALIDITY`, se reconstruye el índice.
- Preferir `text/plain`; si solo hay HTML, convertir a texto y quitar firmas.
- No descargar adjuntos en el MVP.

**Polling, no IDLE:** una conexión IMAP permanente cuesta batería y se cae con Doze. Se abre, se busca, se cierra. Cada 30–60 min es suficiente para alertas bancarias.

**Qué NO hacer:** reenviar correos a un servicio externo de “email a Telegram” (salen del teléfono), ni dar una app password del correo principal si se puede evitar.

### 7.3 Pegado/forward manual

Antes de pedir permisos, el MVP puede funcionar con:

```bash
finanzas.js ingest text "BDV: Consumo TDD ****1234..." --fuente sms --emisor 2665 --dry-run
```

Esto permite construir y probar perfiles con 10–20 mensajes reales sin tocar SMS ni IMAP. Es también el fallback cuando un banco manda un formato nuevo.

### 7.4 Por qué no WhatsApp ni notificaciones push

- WhatsApp no es el canal de los bancos y requeriría otra integración.
- Las notificaciones push de apps bancarias requerirían un `NotificationListenerService`, que Termux:API no ofrece; implicaría una app externa con acceso a todas las notificaciones. Se puede evaluar después, pero no es MVP.

---

## 8. Dedupe, confianza y modos

### 8.1 Score de confianza

| Señal | Puntos |
|---|---|
| Perfil + emisor exactos | +0.25 |
| Monto parseado sin ambigüedad | +0.25 |
| Moneda explícita | +0.10 |
| Naturaleza explícita | +0.20 |
| Cuenta resuelta | +0.10 |
| Comercio extraído | +0.05 |
| Referencia presente | +0.05 |
| Fecha del cuerpo | +0.05 |
| Fecha tomada del mensaje | −0.10 |
| Monto ambiguo | −0.20 |
| Cuenta desconocida | −0.15 |
| Varios candidatos de dedupe | −0.15 |

El score se clampea a `1.0`. Umbrales:

- `≥ 0.90` → auto (si el modo lo permite).
- `0.55–0.89` → revisión.
- `< 0.55` → revisión con motivo; nunca auto.

Reglas adicionales: monto > `auto_max_usd` → revisión; primera semana de un perfil nuevo → revisión; cuenta desconocida → revisión.

### 8.2 Modos

| Modo | Qué hace | Cuándo |
|---|---|---|
| `dry-run` | Parsea y muestra, no escribe nada | Desarrollo y calibración |
| `confirm` | Escribe en la bandeja, el usuario confirma | Primeras 2 semanas |
| `auto` | Alta confianza va directo; el resto a revisión | Producción madura |

Default: `confirm`. No se pasa a `auto` hasta validar 20–30 mensajes reales sin errores de signo, cuenta o duplicado.

### 8.3 Ejemplo completo

SMS 14:32:

```text
BDV: Consumo TDD ****1234 por Bs. 1.234,56 en FARMATODO, 10/11/26 14:30, Ref 123456. Saldo Bs. 45.678,90
```

Email 14:33:

```text
Notificación de transacción
Comercio: FARMATODO
Monto: Bs 1.234,56
Tarjeta: ****1234
Fecha: 10/11/2026
Referencia: 123456
```

Resultado:

- SMS: perfil `bdv-sms-v1`, monto `1234.56 VES`, naturaleza `gasto`, cuenta `bdv-debito-1234`, comercio `FARMATODO`, ref `123456`, confianza `0.98`.
- Email: misma huella (`cuenta|fecha|monto|moneda|naturaleza|ref`) → duplicado, se enlaza, no se crea otra transacción.
- Categoría: `salud` por regla de Farmatodo.
- Presupuesto salud: 45 % → sin alerta.
- Digest: “1 gasto · Bs 1.234,56 ($1,71) · Farmatodo · salud”.

---

## 9. Interfaz

### 9.1 CLI propuesto

| Comando | Qué hace |
|---|---|
| `finanzas.js ingest text "<texto>" --fuente sms --emisor 2665 --dry-run` | Probar un mensaje suelto |
| `finanzas.js ingest sms [--since 7d] [--dry-run]` | Leer SMS |
| `finanzas.js ingest email [--desde 7d] [--dry-run]` | Leer correo |
| `finanzas.js ingest run [--quiet]` | Ambas fuentes; pensado para JobScheduler |
| `finanzas.js ingest status` | Última corrida, conteos, errores, perfil sin match |
| `finanzas.js ingest prune [--days 90]` | Borra texto viejo de `ingestas.jsonl`, conserva el parseo |
| `finanzas.js ingest doctor` | Chequea Termux:API, permiso SMS, IMAP, perfiles, disco |
| `finanzas.js inbox [--estado revisar] [--limit 20]` | Cola de revisión |
| `finanzas.js inbox show <ing_id>` | Detalle con texto redactado y motivo |
| `finanzas.js inbox confirm <ing_id> [--cat ...]` | Registrar a mano |
| `finanzas.js inbox ignore <ing_id> [--motivo ...]` | Descartar |
| `finanzas.js inbox replay <ing_id>` | Reprocesar tras corregir perfil |
| `finanzas.js tx list [--desde ...] [--cuenta ...] [--origen ...]` | Consultar movimientos |
| `finanzas.js tx undo <tx_id>` | Marcar `anulada` |
| `finanzas.js tx cat <tx_id> <categoria>` | Corregir categoría y aprender |
| `finanzas.js accounts list\|add\|edit\|rm` | Gestionar cuentas |
| `finanzas.js rules list\|add\|test` | Gestionar reglas de comercio |
| `finanzas.js migrate` | Migrar CSV a v2 con backup |

Salida corta por defecto; `--json` solo para scripts.

### 9.2 Uso desde el agente

Se agrega una sección de ~10 líneas en `AGENTS.user.md` y `AGENTS.dev.md`:

```markdown
### Ingesta financiera
- SMS/email bancarios → `finanzas.js ingest sms|email` (nunca leer CSV a mano).
- Dudas → `finanzas.js inbox`; confirmar con `inbox confirm`, descartar con `inbox ignore`.
- “¿qué se registró hoy?” → `finanzas.js tx list --desde hoy`.
- “ese gasto era de salud” → `finanzas.js tx cat <tx_id> salud`.
- “deshacelo” → `finanzas.js tx undo <tx_id>`.
- No registro una operación declinada como gasto.
- No mando texto bancario crudo al modelo ni a servicios externos.
```

Ejemplos de conversación:

| Dice... | Hace... |
|---|---|
| “¿qué se registró hoy?” | `tx list --desde hoy --origen sms,email` |
| “ese de Farmatodo era salud” | `tx cat tx-... salud` (y aprende la regla) |
| “¿algo raro?” | `inbox --estado revisar` |
| “deshacé el último” | `tx undo tx-...` |
| “activá automático” | Cambia `config.json → modo=auto` después de confirmar |
| “¿por qué no entró este SMS?” | `inbox --estado error` / `ingest doctor` |

### 9.3 Digest diario

```text
Finanzas · mar 10/11
3 movimientos nuevos · gastos $14,20 · ingresos $0
- Farmatodo $1,71 · salud
- Uber $2,50 · transporte
- Netflix $9,99 · suscripciones
Revisar: 1 sin categoría (TIENDA XYZ), 1 posible duplicado
```

Máximo 10 líneas. Si no hay nada, no se envía. Un solo mensaje al día.

---

## 10. Privacidad y seguridad

| Riesgo | Mitigación |
|---|---|
| OTP y claves en SMS | Filtro antes de guardar; nunca se persiste el código |
| Número completo de tarjeta | Se guarda solo `****1234`; se redacta el resto |
| Phishing con remitente falsificado | No se siguen links; se marca sospechoso y se alerta |
| Correo personal expuesto | Correo dedicado solo para alertas; o OAuth `gmail.readonly` |
| App password con acceso total | Solo si el usuario acepta; preferir correo dedicado |
| Texto bancario al LLM | MVP sin LLM; fallback futuro solo con redacción y opt-in |
| Credenciales en logs | `~/.env` con permisos 600; logs sin usuario/password |
| Backup a Telegram | Ya incluye finanzas; opción de excluir `ingestas.jsonl` y texto crudo |
| Permiso SMS global | Se declara explícitamente; el script filtra por remitente |
| Retención | Texto redactado 90 días (configurable); auditoría parseada permanente |

Regla firme: **el agente nunca manda un SMS, nunca responde un email bancario y nunca ejecuta una acción financiera.** Solo lee y registra.

---

## 11. Operación y batería

| Consumo | Impacto | Decisión |
|---|---|---|
| Proceso en reposo | 0 | No hay daemon ni watcher |
| JobScheduler | 1 proceso corto por corrida | Cada 30 min; 48 ejecuciones/día |
| Llamada a Termux:API | ~100–500 ms | Solo remitentes configurados |
| Conexión IMAP | 1–3 s por corrida | Cada 60 min; sin IDLE |
| LLM en background | 0 | Parseo determinístico |
| Digest | 1 job shell/día | Sin LLM |

- `--quiet` no imprime nada si no hay cambios.
- SMS y email pueden ser dos jobs separados (30 y 60 min) o uno solo cada 30 min. El MVP usa dos para no abrir IMAP de más.
- Logs en `~/workspace/finanzas/logs/` con rotación mensual.
- `ingest status` muestra última corrida, mensajes nuevos, duplicados, revisión y errores.
- Retención: `ingest prune` borra el `texto` de las ingestas más viejas que `retencion_texto_dias`; conserva `hash`, `parse`, `confianza`, `estado` y `tx_ids` para auditoría.
- `ingest doctor` verifica:
  - `termux-api` instalado y permiso SMS,
  - login IMAP y carpeta,
  - perfiles con tests,
  - disco y permisos de escritura,
  - jobs programados.
- Concurrencia: append atómico para transacciones e ingestas; lock para migración y reescrituras. Un solo usuario, sin necesidad de transacciones ACID.

---

## 12. Testing

- `fixtures/sms/*.txt` y `fixtures/email/*.eml` con mensajes reales anonimizados.
- `ingest test` corre todos los fixtures y compara el resultado esperado; no escribe datos reales.
- Tests obligatorios del parser de montos: `1.234,56`, `1,234.56`, `12,34`, `12.34`, `1.234`, `Bs.`, `$`, `USD`.
- Tests de dedupe:
  - SMS + email mismo consumo → 1 transacción.
  - dos Uber iguales el mismo día → 2 transacciones.
  - mismo SMS reprocesado → 0 nuevas.
- Test de signo: consumo → gasto; abono → ingreso; transferencia interna → neutro.
- Test de OTP: no se guarda el código.
- Test de migración: CSV viejo → v2 → reportes siguen funcionando.
- Aceptación con 20–30 mensajes reales: 0 duplicados, 0 signos invertidos, 0 transferencias internas contadas como gasto.

---

## 13. Plan por fases

### Fase 0 — Núcleo y dry-run (1 sesión)

- Migración v2 + IDs + `estado`.
- `ingest text`, `ingestas.jsonl`, perfiles, parser de montos, dedupe, `inbox`, `tx undo/cat`.
- Fixtures con 10–20 mensajes reales.
- **Sin permisos de SMS ni IMAP todavía.**
- Criterio: los fixtures parsean bien y el dry-run no escribe nada.

### Fase 1 — SMS (1 sesión)

- Instalar Termux:API, permiso SMS.
- Leer solo remitentes configurados.
- Modo `confirm` durante 1–2 semanas.
- Criterio: 20 SMS reales, 0 duplicados, 0 errores de signo.

### Fase 2 — Email (1 sesión)

- Correo dedicado o IMAP del usuario.
- `imapflow` + `mailparser`, búsqueda por remitente, sin marcar leído.
- Modo `confirm`.
- Criterio: 20 emails reales, dedupe cruzado con SMS funcionando.

### Fase 3 — Auto + digest (1 sesión + calibración)

- Pasar a `auto` con umbral 0.90 y tope de monto.
- Digest diario por JobScheduler/cron.
- Alertas de presupuesto sin spam.
- Criterio: una semana sin falsos positivos; el usuario confía en el libro.

### Fase 4 — Opcional

- SMS en tiempo real con MacroDroid.
- Aprendizaje de categorías y comercios.
- Detección de suscripciones recurrentes.
- Conciliación de saldos (`saldos.json`).
- Lectura de estados de cuenta PDF.

### Rollback

1. `config.json → ingesta.enabled=false`.
2. Cancelar el job de JobScheduler (`termux-job-scheduler --cancel --job-id ...`).
3. Revertir la extensión y `registry.json`.
4. Restaurar el backup del CSV si se migró.
5. Los datos de `ingestas.jsonl` quedan; se borran aparte si se quiere.

---

## 14. Riesgos y tradeoffs

| Riesgo | Mitigación |
|---|---|
| El banco cambia el formato del SMS | Perfiles versionados, tests, estado `revisar`, `doctor` |
| Duplicado SMS + email | Huella con referencia + ventana temporal + revisión |
| Dos compras iguales legítimas | No fusionar same-channel sin referencia; solo duplicar si el mensaje es idéntico |
| Transferencia interna contada como gasto | `cuentas.json` obligatorio; cuenta desconocida → revisión |
| Pago de tarjeta contado dos veces | Naturaleza `pago_tarjeta` neutra |
| Tasa de cambio equivocada | Tasa del banco o de la fecha; marcar estimada |
| Monto venezolano mal parseado | Parser locale-aware + tests + revisión si es ambiguo |
| Correo personal expuesto | Correo dedicado; OAuth readonly; app password solo con consentimiento |
| OTP guardado | Filtro previo a persistencia |
| Phishing | No seguir links; alerta; no auto-registrar |
| Android mata Termux | JobScheduler + exclusión de batería; probar 48 h |
| Permiso SMS invasivo | Declararlo; filtrar remitentes; no leer todo |
| Falsa sensación de exactitud | Digest muestra revisión; `undo`; modo confirm inicial |
| Crecimiento de `ingestas.jsonl` | ~30 líneas/día = ~11k/año; rotación anual opcional |
| Dos escritores (job + Telegram) | Append atómico + lock para reescrituras |

---

## 15. Decisiones que necesito de vos

1. **Bancos y canales.** ¿Qué bancos/tarjetas te mandan alertas, por SMS, por email o ambos? ¿Desde qué remitentes/short codes? Sin esto no se pueden escribir perfiles reales.
2. **Correo.** ¿Usás Gmail, Outlook u otro? ¿Aceptás crear un correo dedicado solo para alertas bancarias (recomendado), o preferís dar acceso al correo principal con app password/OAuth?
3. **Modo inicial.** ¿Arrancamos en `confirm` dos semanas (recomendado) o querés `auto` desde el día uno?
4. **Contabilidad.** ¿Transferencias entre cuentas propias, pago de tarjeta y retiros de cajero quedan neutros (recomendado), o preferís que algunos cuenten como gasto?
5. **SMS en tiempo real.** ¿JobScheduler cada 30 min (simple, suficiente) o MacroDroid para que entre en segundos?
6. **Avisos.** ¿Silencio + digest diario (recomendado), o aviso inmediato para montos arriba de un tope? ¿Cuál tope?
7. **Retención.** ¿90 días de texto redactado (recomendado) o preferís no guardar el texto y solo el resultado parseado?
8. **Moneda base.** El sistema ya está en USD con Bs opcional. ¿Seguimos así?

Con las respuestas 1–4 alcanza para la fase 0. Las muestras reales de SMS/email son el insumo más importante: 10–20 por banco, con montos y nombres tapados si querés.

---

## 16. Archivos que tocaría (cuando se apruebe)

**Nuevos**

```text
pi-system/extensions/pi-tool-finanzas/ingest.js
pi-system/extensions/pi-tool-finanzas/lib/amount.js
pi-system/extensions/pi-tool-finanzas/lib/dedupe.js
pi-system/extensions/pi-tool-finanzas/lib/profiles.js
pi-system/extensions/pi-tool-finanzas/lib/sources/sms-termux.js
pi-system/extensions/pi-tool-finanzas/lib/sources/imap.js
pi-system/extensions/pi-tool-finanzas/fixtures/sms/
pi-system/extensions/pi-tool-finanzas/fixtures/email/
```

**Editados**

```text
pi-system/extensions/pi-tool-finanzas/finanzas.js       # v2, migrate, tx, ingest
pi-system/extensions/pi-tool-finanzas/package.json      # imapflow, mailparser
pi-system/extensions/pi-tool-finanzas/manifest.json     # env, entries, APIs
pi-system/registry.json                                 # sin extensión nueva
pi-system/docs/DEPENDENCIES.md                          # regenerado
workspace/finanzas/README.md                            # esquema v2 + ingesta
workspace/AGENTS.user.md                                # sección de ~10 líneas
workspace/AGENTS.dev.md                                 # idéntica
```

**Sin cambios intencionales**

```text
workspace/finanzas/transacciones.csv   # solo migración de encabezado, con backup
.pi/agent/settings.json                # no se carga como extensión
workspace/TAREAS.md                    # la ingesta no duplica la cola de trabajo
```

---

*Propuesta escrita para `pi-personal-agent`. Si se aprueba, la implementación sigue el Developer Protocol: manifest honesto, versión, tests, migración con backup, regenerar `DEPENDENCIES.md` y probar primero en dry-run.*
