# Sistema de Finanzas Personales

Sistema de gestión financiera personal vía CSV + Node.js. Registra transacciones en USD (con soporte opcional para una segunda moneda local), gestiona préstamos y genera reportes mensuales.

> **Multi-locale.** Por defecto opera en modo **USD puro**. Para activar una segunda moneda, exportá `FX_ENABLED=true` + `FX_API_URL` + `FX_LABEL` + `FX_SYMBOL`. Ver `.env.example` para los detalles del provider que prefieras.

## Bootstrap (primera vez)

```bash
node ~/pi-system/extensions/pi-tool-finanzas/finanzas.js bootstrap
```

Copia los templates desde `pi-system/extensions/pi-tool-finanzas/templates/` a `~/workspace/finanzas/`:
`transacciones.csv`, `prestamos.csv`, `presupuestos.json`, `inversiones/operaciones.csv`, `inversiones/activos.json`. Es idempotente: no sobrescribe archivos existentes.

## Estructura de Archivos

```
~/workspace/finanzas/
├── transacciones.csv        # Libro mayor de transacciones
├── prestamos.csv            # Registro de préstamos / pendientes
├── presupuestos.json        # Límites mensuales por categoría
├── tasas.json               # Cache de tasas FX (sólo si FX_ENABLED=true)
├── reports/                 # Reportes mensuales generados
└── inversiones/             # Módulo de portafolio
    ├── activos.json
    ├── operaciones.csv
    ├── reportes/
    └── README.md
```

## Comandos Básicos

### Registrar un gasto
```bash
node finanzas.js add "<descripción>" <monto> [opciones]
```

**Opciones:**
- `--cat <categoría>` — categoría (ver `presupuestos.json`)
- `--tipo <ingreso|gasto>` — default: `gasto`
- `--moneda <USD|<FX_SYMBOL>>` — sólo aplica si `FX_ENABLED=true`
- `--fecha <YYYY-MM-DD>` — default: hoy
- `--notas "..."`

### Préstamos
```bash
node finanzas.js loan-add "<persona>" <monto> "<descripción>"
node finanzas.js loan-list
node finanzas.js loan-pay <id> <monto>
```

### Balance / búsqueda / tasa / reporte
```bash
node finanzas.js balance                       # mes actual
node finanzas.js balance --mes YYYY-MM         # mes específico
node finanzas.js search "<texto>"              # busca por texto
node finanzas.js search --cat <cat> --tipo <t>
node finanzas.js search --desde YYYY-MM-DD --hasta YYYY-MM-DD
node finanzas.js tasa                          # consulta FX si está activo
node finanzas.js report                        # mes actual
node finanzas.js report YYYY-MM                # mes específico
```

## Alertas de Presupuesto

Al registrar un gasto, el sistema calcula el % del presupuesto usado en esa categoría:

- ✅ < 80%
- ⚠️ 80–99%
- 🚨 ≥ 100%

Editá `presupuestos.json` para ajustar los límites mensuales.

## Reporte Automático Mensual

Configurable vía `pi-cron`: ej. el día 1 de cada mes a las 9am, generar el reporte del mes anterior en `reports/YYYY-MM.md`.

## Portafolio de Inversiones

Submódulo `inversiones/` para gestionar tu portafolio. Activos y allocations son 100% configurables en `inversiones/activos.json`.

```bash
cd inversiones
node inversiones.js balance
node inversiones.js dca
node inversiones.js report
```

Detalles en [`inversiones/README.md`](inversiones/README.md).

## Migración a Otro Dispositivo

El sistema es **100% portable**. No depende de bases de datos. Solo necesitas **Node.js** (y conexión a internet si activás FX).

1. Copiá `~/workspace/finanzas/` al nuevo dispositivo.
2. Instalá Node.js (`pkg install node` en Termux).
3. Ejecutá `node finanzas.js` como siempre.

### Compartir con otra persona — partir de cero

```bash
cd finanzas
rm transacciones.csv prestamos.csv tasas.json reports/*.md 2>/dev/null
```

Luego editá `presupuestos.json` con los límites que correspondan.

### Conservar plantilla, borrar movimientos

```bash
cd finanzas
echo "fecha,descripcion,monto_usd,monto_bs,moneda_origen,tasa,categoria,tipo,notas" > transacciones.csv
echo "id,persona,monto_original,saldo,fecha,descripcion,estado" > prestamos.csv
echo "{}" > tasas.json
```

> Nota: las columnas `monto_bs` / `tasa_bcv` son nombres heredados del modo FX por defecto. El significado real es "monto en moneda secundaria" / "tasa FX". Si activás FX con otro símbolo, el dato se llena igual; si trabajás en modo USD puro, quedan vacías.

## Notas Técnicas

- Si `FX_ENABLED=true`, la tasa se consulta del endpoint definido en `FX_API_URL` y se cachea por día en `tasas.json`.
- Montos guardados en USD (y opcionalmente moneda secundaria) para auditoría.
- Fechas internas: `YYYY-MM-DD` (ISO).
- CSVs editables a mano si respetás el formato.
