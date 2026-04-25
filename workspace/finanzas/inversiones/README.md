# Módulo de Inversiones

Gestión de portafolio integrado con `finanzas.js`. Soporta cualquier mix de activos: crypto, stablecoins, ETFs, metales, acciones (locales o globales) — todo configurable vía `activos.json`.

## Definir el portafolio

Editá `activos.json` para registrar cada activo. Cada entrada acepta:

| Campo | Uso |
|---|---|
| `nombre` | Nombre legible |
| `tipo` | `crypto` / `stock` / `stable` / `metal` / `etf` / `other` |
| `symbol` | Ticker en Binance para auto-precio (omitir para precio manual) |
| `moneda_base` | `USDT` / `USD` / `<FX_SYMBOL>` |
| `target_pct` | % objetivo del portafolio |
| `dca` | `true` para incluir en DCA tracking |
| `dca_meta_mensual_usd` | Meta DCA mensual en USD |
| `precio_manual` | Precio fijo si no hay API (override con `set-precio`) |
| `news_query` | Query Tavily custom para reporte |
| `skip_news` | `true` para omitir del bloque de noticias |

Ejemplo `activos.json` (incluido en templates):

```json
{
  "BTC":  { "nombre": "Bitcoin",  "tipo": "crypto", "symbol": "BTCUSDT",  "moneda_base": "USDT", "target_pct": 30, "dca": true, "dca_meta_mensual_usd": 100 },
  "ETH":  { "nombre": "Ethereum", "tipo": "crypto", "symbol": "ETHUSDT",  "moneda_base": "USDT", "target_pct": 20 },
  "PAXG": { "nombre": "PAX Gold", "tipo": "metal",  "symbol": "PAXGUSDT", "moneda_base": "USDT", "target_pct": 20 },
  "USDC": { "nombre": "USD Coin", "tipo": "stable", "moneda_base": "USDT", "precio_manual": 1, "target_pct": 30, "skip_news": true }
}
```

## Comandos

### Registrar operación
```bash
node inversiones.js add <TICKER> <compra|venta|deposito> <cantidad> <precio_unitario> [moneda] [fecha] [notas]
```

```bash
node inversiones.js add BTC compra 0.0002 75000 USDT
node inversiones.js add USDC deposito 500 1 USDT
node inversiones.js add <TICKER> compra <cantidad> <precio> <FX_SYMBOL>   # si FX_ENABLED
```

### Precio / balance / DCA / reporte
```bash
node inversiones.js precios                    # precios actuales
node inversiones.js balance                    # P&L + allocation vs target
node inversiones.js dca                        # tracking DCA (activos con dca:true)
node inversiones.js report                     # reporte completo en reportes/YYYY-MM-DD.md
node inversiones.js list [TICKER]              # historial de operaciones
node inversiones.js set-precio <TICKER> <precio>   # precio manual
```

## Archivos

- `activos.json` — configuración del portafolio
- `operaciones.csv` — historial de operaciones
- `reportes/` — reportes generados en Markdown

## Notas

- **Activos sin API:** definí `precio_manual` en `activos.json` o usá `set-precio` para fijarlo. Útil para acciones ilíquidas o tokens sin par en Binance.
- **Stablecoins en earn:** registralas como `deposito` para que cuenten en el portafolio total. Sin esto, la allocation del resto se distorsiona.
- **DCA:** la meta mensual se define por activo (`dca_meta_mensual_usd`). El comando `dca` calcula cuánto falta para cumplir target + DCA semanal sugerida.
- **Tasa FX:** si `FX_ENABLED=true` se cachea en `../tasas.json` compartido con `finanzas.js`. En modo USD puro (default) los campos en moneda secundaria quedan vacíos.
