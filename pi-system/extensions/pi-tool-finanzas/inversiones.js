#!/usr/bin/env node
/**
 * @module pi-tool-finanzas (inversiones)
 * @data ~/workspace/finanzas/inversiones/, ~/workspace/finanzas/tasas.json
 * @user-docs ~/workspace/AGENTS.md#finanzas
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const HOME = process.env.PI_HOME || os.homedir();
const FINANZAS_DIR = process.env.FINANZAS_DATA_DIR || path.join(HOME, 'workspace', 'finanzas');
const DATA_DIR = path.join(FINANZAS_DIR, 'inversiones');
const OPS_CSV = path.join(DATA_DIR, 'operaciones.csv');
const ACTIVOS_JSON = path.join(DATA_DIR, 'activos.json');
const REPORTS_DIR = path.join(DATA_DIR, 'reportes');
const TASAS_JSON = path.join(FINANZAS_DIR, 'tasas.json');

const FX_ENABLED = (process.env.FX_ENABLED || 'false').toLowerCase() === 'true';
const FX_API_URL = process.env.FX_API_URL || '';
const FX_LABEL = process.env.FX_LABEL || 'FX';
const FX_SYMBOL = process.env.FX_SYMBOL || '';

const TAVILY_SCRIPT = process.env.TAVILY_SCRIPT_PATH
  || path.join(HOME, 'pi-system/extensions/pi-tool-tavily/tavily.js');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── Utilidades ───────────────────────────────────────────────
function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseFecha(str) {
  if (!str) return hoy();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return str;
}

function fmtFecha(str) {
  if (!str) return '';
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return str;
}

function csvEscape(s) {
  if (s == null) return '';
  s = String(s);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvLine(arr) {
  return arr.map(csvEscape).join(',') + '\n';
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        cells.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  cells.push(cur);
  return cells;
}

function readCsv(file, required = true) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`No existe: ${file}`);
    return [];
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => row[h] = cells[idx] || '');
    out.push(row);
  }
  return out;
}

function appendCsv(file, obj, headers) {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, csvLine(headers));
  }
  const row = headers.map(h => obj[h] ?? '');
  fs.appendFileSync(file, csvLine(row));
}

function readJson(file, def = {}) {
  if (!fs.existsSync(file)) return def;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return def;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function fmtUsd(n) {
  if (n == null || n === '') return '-';
  return '$' + Number(n).toFixed(2);
}

function fmtBs(n) {
  if (n == null || n === '') return '-';
  return Number(n).toFixed(2) + ' ' + FX_SYMBOL;
}

function fmtPct(n) {
  if (n == null || n === '') return '-';
  const s = Number(n).toFixed(1);
  return (n >= 0 ? '+' : '') + s + '%';
}

// ─── Tasa FX ──────────────────────────────────────────────────
async function fetchTasa() {
  if (!FX_ENABLED) return { tasa: 1, fecha: hoy(), fuente: 'fx-disabled' };
  const res = await fetch(FX_API_URL, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const tasa = parseFloat(data.promedio || data.venta || data.compra || data.precio || data.rate || data.value);
  if (!tasa || isNaN(tasa)) throw new Error('Tasa invalida');
  return { tasa, fecha: data.fechaActualizacion ? data.fechaActualizacion.slice(0, 10) : (data.fecha || hoy()), fuente: data.fuente || FX_LABEL };
}

async function getTasaFx(force = false) {
  if (!FX_ENABLED) return { tasa: 1, fecha: hoy(), cached: true };
  const tasas = readJson(TASAS_JSON, {});
  const today = hoy();
  if (!force && tasas[today]) {
    return { tasa: tasas[today].tasa, fecha: today, cached: true };
  }
  const info = await fetchTasa();
  tasas[today] = { tasa: info.tasa, fuente: info.fuente, consulta: new Date().toISOString() };
  writeJson(TASAS_JSON, tasas);
  return { tasa: info.tasa, fecha: today, cached: false };
}

// ─── Precios ──────────────────────────────────────────────────
async function fetchBinancePrice(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status} para ${symbol}`);
  const data = await res.json();
  return parseFloat(data.price);
}

async function getPrecios(activos) {
  const precios = {};
  for (const [codigo, info] of Object.entries(activos)) {
    if (info.precio_manual) {
      precios[codigo] = info.precio_manual;
    } else if (info.symbol) {
      try {
        precios[codigo] = await fetchBinancePrice(info.symbol);
      } catch (e) {
        precios[codigo] = 0;
      }
    } else {
      precios[codigo] = 0;
    }
  }
  return precios;
}

function buscarConTavily(query) {
  try {
    if (!fs.existsSync(TAVILY_SCRIPT)) return null;
    const out = execSync(`node "${TAVILY_SCRIPT}" search "${query.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 30000 });
    const data = JSON.parse(out);
    return data;
  } catch (e) {
    return null;
  }
}

function noticiasActivos() {
  const activos = readJson(ACTIVOS_JSON, {});
  const year = new Date().getFullYear();
  const resultados = {};
  for (const [codigo, info] of Object.entries(activos)) {
    if (info.skip_news) continue;
    const query = info.news_query || `${info.nombre || codigo} ${codigo} noticias precio outlook ${year}`;
    resultados[codigo] = buscarConTavily(query);
  }
  return resultados;
}

// ─── Lógica de negocio ────────────────────────────────────────
function calcularPosiciones(operaciones, precios, tasa) {
  const activos = readJson(ACTIVOS_JSON, {});
  const pos = {};

  for (const [codigo, info] of Object.entries(activos)) {
    pos[codigo] = {
      codigo,
      nombre: info.nombre,
      tipo: info.tipo,
      cantidad: 0,
      invertido_usd: 0,
      invertido_bs: 0,
      cost_basis_usd: 0,
      precio_actual: precios[codigo] || info.precio_manual || 0,
      moneda_base: info.moneda_base || 'USDT',
      target_pct: info.target_pct || 0,
      valor_usd: 0,
      valor_bs: 0,
      pnl_usd: 0,
      pnl_pct: 0,
      allocation_actual: 0,
      allocation_dif: 0
    };
  }

  for (const op of operaciones) {
    const p = pos[op.activo];
    if (!p) continue;
    const cantidad = parseFloat(op.cantidad || 0);
    const total_usd = parseFloat(op.monto_usd || 0);
    const total_bs = parseFloat(op.monto_bs || 0);

    if (op.tipo_operacion === 'compra') {
      p.cantidad += cantidad;
      p.invertido_usd += total_usd;
      p.invertido_bs += total_bs;
    } else if (op.tipo_operacion === 'venta') {
      if (p.cantidad > 0) {
        const ratio = cantidad / p.cantidad;
        p.invertido_usd *= (1 - ratio);
        p.invertido_bs *= (1 - ratio);
      }
      p.cantidad -= cantidad;
    } else if (op.tipo_operacion === 'deposito' || op.tipo_operacion === 'dividendo') {
      p.cantidad += cantidad;
      p.invertido_usd += total_usd;
      p.invertido_bs += total_bs;
    }
  }

  let total_portafolio_usd = 0;

  for (const codigo in pos) {
    const p = pos[codigo];
    if (p.cantidad > 0) {
      p.cost_basis_usd = p.invertido_usd / p.cantidad;
    }

    if (p.moneda_base === 'Bs') {
      p.valor_bs = p.cantidad * p.precio_actual;
      p.valor_usd = p.valor_bs / tasa;
    } else {
      p.valor_usd = p.cantidad * p.precio_actual;
      p.valor_bs = p.valor_usd * tasa;
    }

    p.pnl_usd = p.valor_usd - p.invertido_usd;
    p.pnl_pct = p.invertido_usd > 0 ? (p.pnl_usd / p.invertido_usd) * 100 : 0;
    total_portafolio_usd += p.valor_usd;
  }

  for (const codigo in pos) {
    const p = pos[codigo];
    p.allocation_actual = total_portafolio_usd > 0 ? (p.valor_usd / total_portafolio_usd) * 100 : 0;
    p.allocation_dif = p.allocation_actual - p.target_pct;
  }

  return { posiciones: pos, total_portafolio_usd, tasa };
}

function recomendacionRebalanceo(p) {
  if (p.allocation_dif > 2) return `Vender ~${fmtUsd(p.valor_usd * (p.allocation_dif / 100))}`;
  if (p.allocation_dif < -2) return `Comprar ~${fmtUsd(p.valor_usd * (-p.allocation_dif / 100))}`;
  return 'OK';
}

// ─── Comandos ─────────────────────────────────────────────────
async function cmdAdd(argv) {
  const activo = argv._[1];
  const tipo = argv._[2];
  const cantidadRaw = argv._[3];
  const precioRaw = argv._[4];
  if (!activo || !tipo || !cantidadRaw || !precioRaw) {
    console.log(JSON.stringify({ ok: false, error: 'Uso: add <activo> <compra|venta|deposito> <cantidad> <precio_unitario> [moneda] [fecha] [notas]' }));
    process.exit(1);
  }

  const activos = readJson(ACTIVOS_JSON, {});
  if (!activos[activo]) {
    console.log(JSON.stringify({ ok: false, error: `Activo desconocido: ${activo}. Registralo primero en activos.json` }));
    process.exit(1);
  }

  const moneda = argv.moneda || activos[activo].moneda_base || 'USDT';
  const cantidad = parseFloat(cantidadRaw);
  const precio = parseFloat(precioRaw);
  const fecha = parseFecha(argv.fecha);
  const notas = argv.notas || '';

  let monto_usd = 0, monto_bs = 0;
  const info = await getTasaFx();
  const tasa = info.tasa;

  if (moneda === 'Bs') {
    monto_bs = cantidad * precio;
    monto_usd = +(monto_bs / tasa).toFixed(4);
  } else {
    monto_usd = cantidad * precio;
    monto_bs = +(monto_usd * tasa).toFixed(2);
  }

  const row = {
    fecha, activo, tipo_operacion: tipo, cantidad, precio_unitario: precio,
    moneda, monto_usd, monto_bs, tasa_bcv: tasa, notas
  };
  appendCsv(OPS_CSV, row, ['fecha', 'activo', 'tipo_operacion', 'cantidad', 'precio_unitario', 'moneda', 'monto_usd', 'monto_bs', 'tasa_bcv', 'notas']);

  console.log(JSON.stringify({
    ok: true,
    msg: `Registrado: ${tipo} ${cantidad} ${activo} @ ${precio} ${moneda}`,
    row
  }, null, 2));
}

async function cmdPrecios(argv) {
  const activos = readJson(ACTIVOS_JSON, {});
  const precios = await getPrecios(activos);
  console.log(JSON.stringify({ ok: true, precios, fecha: hoy() }, null, 2));
}

async function cmdBalance(argv) {
  const ops = readCsv(OPS_CSV, false);
  const activos = readJson(ACTIVOS_JSON, {});
  const precios = await getPrecios(activos);
  const info = await getTasaFx();
  const { posiciones, total_portafolio_usd, tasa } = calcularPosiciones(ops, precios, info.tasa);

  const resumen = Object.values(posiciones).map(p => ({
    activo: p.codigo,
    nombre: p.nombre,
    cantidad: +p.cantidad.toFixed(8),
    invertido_usd: fmtUsd(p.invertido_usd),
    valor_usd: fmtUsd(p.valor_usd),
    pnl_usd: fmtUsd(p.pnl_usd),
    pnl_pct: fmtPct(p.pnl_pct),
    allocation_actual: p.allocation_actual.toFixed(1) + '%',
    target_pct: p.target_pct + '%',
    accion: recomendacionRebalanceo(p)
  }));

  console.log(JSON.stringify({
    ok: true,
    fecha: hoy(),
    tasa_bcv: tasa.toFixed(2),
    total_portafolio_usd: fmtUsd(total_portafolio_usd),
    total_portafolio_bs: fmtBs(total_portafolio_usd * tasa),
    posiciones: resumen
  }, null, 2));
}

function dcaAssets() {
  const activos = readJson(ACTIVOS_JSON, {});
  return Object.entries(activos)
    .filter(([_, info]) => info.dca === true)
    .map(([codigo, info]) => ({ codigo, info }));
}

function calcularDcaAsset(codigo, info, ops, precioActivo) {
  const today = hoy();
  const [year, month] = today.split('-');
  const prefix = `${year}-${month}`;

  const comprasMes = ops.filter(o => o.activo === codigo && o.tipo_operacion === 'compra' && (o.fecha || '').startsWith(prefix));
  const totalCompradoMes = comprasMes.reduce((a, o) => a + parseFloat(o.monto_usd || 0), 0);
  const comprasRealizadas = comprasMes.length;

  const metaMensual = info.dca_meta_mensual_usd || 0;
  const faltaMeta = metaMensual - totalCompradoMes;
  const semanaActual = Math.min(4, Math.ceil(parseInt(today.slice(8)) / 7));
  const semanasRestantes = Math.max(1, 4 - semanaActual + 1);
  const compraSemanalSugerida = faltaMeta > 0 ? faltaMeta / semanasRestantes : 0;

  const precios = { [codigo]: precioActivo };
  const { posiciones, total_portafolio_usd } = calcularPosiciones(ops, precios, 1);
  const pos = posiciones[codigo] || { valor_usd: 0 };
  const targetAllocationUsd = total_portafolio_usd * ((info.target_pct || 0) / 100);
  const faltaAllocation = targetAllocationUsd - pos.valor_usd;

  return {
    activo: codigo,
    meta_mensual: metaMensual,
    total_comprado_mes: +totalCompradoMes.toFixed(2),
    compras_realizadas: comprasRealizadas,
    semana_actual: semanaActual,
    semanas_restantes: semanasRestantes,
    falta_meta: +faltaMeta.toFixed(2),
    compra_semanal_sugerida: +compraSemanalSugerida.toFixed(2),
    falta_allocation: +faltaAllocation.toFixed(2),
    target_allocation_usd: +targetAllocationUsd.toFixed(2),
    activo_actual_usd: +pos.valor_usd.toFixed(2),
    precio: precioActivo
  };
}

async function cmdDca(argv) {
  const ops = readCsv(OPS_CSV, false);
  const activos = readJson(ACTIVOS_JSON, {});
  const precios = await getPrecios(activos);
  const dcaList = dcaAssets();

  if (dcaList.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      fecha: hoy(),
      msg: 'No DCA assets configured. Mark an asset with `"dca": true` and `"dca_meta_mensual_usd": <amount>` in activos.json.',
      activos_dca: []
    }, null, 2));
    return;
  }

  const result = dcaList.map(({ codigo, info }) => {
    const dca = calcularDcaAsset(codigo, info, ops, precios[codigo] || 0);
    const sobreMeta = dca.falta_meta <= 0;
    const sobreAlloc = dca.falta_allocation <= 0;
    return {
      activo: codigo,
      meta_mensual_usd: fmtUsd(dca.meta_mensual),
      total_comprado_este_mes: fmtUsd(dca.total_comprado_mes),
      compras_realizadas: dca.compras_realizadas,
      semana_actual: dca.semana_actual,
      semanas_restantes: dca.semanas_restantes,
      falta_meta_usd: fmtUsd(Math.abs(dca.falta_meta)),
      estado_meta: sobreMeta ? 'META_CUMPLIDA' : 'PENDIENTE',
      compra_semanal_sugerida: sobreMeta ? 'N/A - meta cumplida' : fmtUsd(dca.compra_semanal_sugerida),
      unidades_semanales: (!sobreMeta && dca.compra_semanal_sugerida > 0 && dca.precio > 0)
        ? (dca.compra_semanal_sugerida / dca.precio).toFixed(6) : 0,
      falta_allocation_usd: fmtUsd(Math.abs(dca.falta_allocation)),
      estado_allocation: sobreAlloc ? 'SOBRE_TARGET' : 'PENDIENTE',
      precio_actual: fmtUsd(dca.precio)
    };
  });

  console.log(JSON.stringify({
    ok: true,
    fecha: hoy(),
    activos_dca: result
  }, null, 2));
}

async function cmdReport(argv) {
  const ops = readCsv(OPS_CSV, false);
  const activos = readJson(ACTIVOS_JSON, {});
  const precios = await getPrecios(activos);
  const info = await getTasaFx();
  const { posiciones, total_portafolio_usd, tasa } = calcularPosiciones(ops, precios, info.tasa);

  let md = `# Reporte de Inversiones - ${fmtFecha(hoy())}\n\n`;
  md += `## Resumen del Portafolio\n\n`;
  md += `- **Valor total:** ${fmtUsd(total_portafolio_usd)} (${fmtBs(total_portafolio_usd * tasa)})\n`;
  md += `- **Tasa ${FX_LABEL}:** ${tasa.toFixed(2)} ${FX_SYMBOL}/$\n`;
  md += `- **Fecha:** ${fmtFecha(hoy())}\n\n`;

  md += `## Posiciones y P&L\n\n`;
  md += `| Activo | Cantidad | Invertido | Valor Actual | P&L ($) | P&L (%) |\n`;
  md += `|--------|----------|-----------|--------------|---------|---------|\n`;
  for (const p of Object.values(posiciones).sort((a, b) => b.valor_usd - a.valor_usd)) {
    if (p.cantidad === 0 && p.invertido_usd === 0) continue;
    md += `| ${p.codigo} | ${p.cantidad.toFixed(6)} | ${fmtUsd(p.invertido_usd)} | ${fmtUsd(p.valor_usd)} | ${fmtUsd(p.pnl_usd)} | ${fmtPct(p.pnl_pct)} |\n`;
  }

  md += `\n## Allocation vs Targets\n\n`;
  md += `| Activo | Target | Actual | Diferencia | Accion |\n`;
  md += `|--------|--------|--------|------------|--------|\n`;
  for (const p of Object.values(posiciones).sort((a, b) => b.allocation_actual - a.allocation_actual)) {
    md += `| ${p.codigo} | ${p.target_pct}% | ${p.allocation_actual.toFixed(1)}% | ${(p.allocation_dif >= 0 ? '+' : '') + p.allocation_dif.toFixed(1)}% | ${recomendacionRebalanceo(p)} |\n`;
  }

  // DCA tracking — driven by activos.json (any asset with `dca: true`)
  const dcaList = dcaAssets();
  if (dcaList.length > 0) {
    md += `\n## DCA Tracking\n\n`;
    for (const { codigo, info } of dcaList) {
      const dca = calcularDcaAsset(codigo, info, ops, precios[codigo] || 0);
      md += `### ${codigo}\n\n`;
      md += `- **Meta mensual:** ${fmtUsd(dca.meta_mensual)}\n`;
      md += `- **Comprado este mes:** ${fmtUsd(dca.total_comprado_mes)} (${dca.compras_realizadas} compras)\n`;
      md += `- **Semana:** ${dca.semana_actual} de 4\n`;
      if (dca.falta_meta > 0) {
        md += `- **Falta para meta:** ${fmtUsd(dca.falta_meta)}\n`;
        const unidades = (dca.compra_semanal_sugerida / (precios[codigo] || 1)).toFixed(6);
        md += `- **Compra semanal sugerida:** ${fmtUsd(dca.compra_semanal_sugerida)} (~${unidades} ${codigo})\n`;
      } else {
        md += `- **Meta mensual cumplida.** No comprar mas este mes.\n`;
      }
      md += `- **Por allocation target:** ${fmtUsd(dca.activo_actual_usd)} / ${fmtUsd(dca.target_allocation_usd)} (${dca.falta_allocation > 0 ? 'faltan ' + fmtUsd(dca.falta_allocation) : 'sobre target ' + fmtUsd(Math.abs(dca.falta_allocation))})\n\n`;
    }
  }

  md += `## Proximos pasos\n\n`;
  const rebalancear = Object.values(posiciones).filter(p => Math.abs(p.allocation_dif) > 2);
  if (rebalancear.length === 0) {
    md += `Allocation dentro de rango tolerable (+-2%). Mantener estrategia DCA configurada.\n`;
  } else {
    for (const p of rebalancear) {
      md += `- **${p.codigo}:** ${recomendacionRebalanceo(p)} para acercarse al ${p.target_pct}%\n`;
    }
  }

  // Noticias via Tavily
  md += `\n## Contexto de Mercado\n\n`;
  const noticias = noticiasActivos();
  for (const [activo, data] of Object.entries(noticias)) {
    md += `### ${activo}\n\n`;
    if (data && data.answer) {
      md += `${data.answer}\n\n`;
    } else {
      md += `_(No se pudo obtener informacion reciente)_\n\n`;
    }
  }

  md += `\n---\n*Generado automaticamente por finanzas/inversiones.js*\n`;

  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `${hoy()}.md`);
  fs.writeFileSync(file, md);

  console.log(JSON.stringify({
    ok: true,
    msg: `Reporte generado: ${file}`,
    fecha: hoy(),
    total_portafolio_usd: fmtUsd(total_portafolio_usd),
    file
  }, null, 2));
}

function cmdSetPrecio(argv) {
  const activo = argv._[1];
  const precioRaw = argv._[2];
  if (!activo || !precioRaw) {
    console.log(JSON.stringify({ ok: false, error: 'Uso: set-precio <activo> <precio>' }));
    process.exit(1);
  }
  const activos = readJson(ACTIVOS_JSON, {});
  if (!activos[activo]) {
    console.log(JSON.stringify({ ok: false, error: `Activo desconocido: ${activo}` }));
    process.exit(1);
  }
  activos[activo].precio_manual = parseFloat(precioRaw);
  writeJson(ACTIVOS_JSON, activos);
  console.log(JSON.stringify({ ok: true, msg: `Precio manual de ${activo} actualizado a ${precioRaw}` }));
}

function cmdList(argv) {
  const ops = readCsv(OPS_CSV, false);
  const activoFilter = argv._[1];
  let results = ops;
  if (activoFilter) {
    results = results.filter(o => o.activo === activoFilter);
  }
  results.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
  console.log(JSON.stringify({ ok: true, count: results.length, operaciones: results }, null, 2));
}

// ─── CLI Parser ───────────────────────────────────────────────
function parseArgv(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const argv = parseArgv(process.argv.slice(2));
  const cmd = argv._[0];

  try {
    switch (cmd) {
      case 'add': await cmdAdd(argv); break;
      case 'precios': await cmdPrecios(argv); break;
      case 'balance': await cmdBalance(argv); break;
      case 'dca': await cmdDca(argv); break;
      case 'report': await cmdReport(argv); break;
      case 'list': cmdList(argv); break;
      case 'set-precio': cmdSetPrecio(argv); break;
      default:
        console.log(JSON.stringify({
          ok: false,
          error: `Comando desconocido: ${cmd}`,
          uso: 'Comandos: add, precios, balance, dca, report, list, set-precio'
        }));
        process.exit(1);
    }
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}

main();
